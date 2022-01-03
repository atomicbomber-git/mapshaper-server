/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
|
| This file is dedicated for defining HTTP routes. A single file is enough
| for majority of projects, however you can define routes in different
| files and just make sure to import them inside this file. For example
|
| Define routes in following two files
| ├── start/routes/cart.ts
| ├── start/routes/customer.ts
|
| and then import them inside `start/routes.ts` as follows
|
| import './routes/cart'
| import './routes/customer'
|
*/

import Route from '@ioc:Adonis/Core/Route'
import {schema} from '@ioc:Adonis/Core/Validator'
import * as Filesystem from "fs/promises"
import {Buffer} from 'buffer';
import * as FileType from 'file-type';
import {Entry} from "unzipper";
import {PathLike} from "fs";

const fs = require("fs")
const unzipper = require("unzipper")
const mapshaper = require("mapshaper")

interface mapShaperOutput {
    "output.geojson": Buffer
}

const unzip = (filePath: PathLike): Promise<Record<string, Buffer>> => new Promise((resolve, reject) => {
    const results: Record<string, Buffer> = {}
    fs.createReadStream(filePath)
        .pipe(unzipper.Parse())
        .on('error', reject)
        .on('entry', async function (entry: Entry) {
            results[entry.path] = await entry.buffer()
        })
        .on('finish', () => {
            resolve(results)
        })
})

interface OutputFormat {
    extension: string,
    mime: string,
}

const mapShaperFormatToMimeMap: Record<string, OutputFormat> = {
    shapefile: { extension: "shp", mime: "application/x-esri-shape" },
    geojson: { extension: "json", mime: "application/json" },
    topojson: { extension: "json", mime: "application/json" },
    json: { extension: "json", mime: "application/json" },
    dbf: { extension: "dbf", mime: "application/dbase" },
    csv: { extension: "csv", mime: "text/csv" },
    tsv: { extension: "tsv", mime: "text/tab-separated-values" },
    svg: { extension: "svg", mime: "image/svg+xml" },
}

const geospatialConvert = async (
    filepath: string,
    filename: string,
    targetFormat: string = "geojson",
    extraOptions: object = {},
): Promise<Buffer> => {
    const fileMime = (await FileType.fromFile(filepath))?.mime
    if (!fileMime) {
        throw {
            type: "FILE_TYPE_ERROR",
            message: `Uploaded file has an unknown / undetectable mime type.`
        }
    }

    let fileBuffers: Record<string, Buffer> = {}

    if (fileMime === "application/zip") {
        fileBuffers = await unzip(filepath)
    } else {
        const fileHandle = await Filesystem.open(filepath, 'r')
        fileBuffers[filename] = await fileHandle.readFile()
        await fileHandle.close()
    }

    const processableFilenames = Object.keys(fileBuffers)
        .filter(filename =>
            filename.endsWith(".shp") ||
            filename.endsWith(".prj")
        )

    const extraOptionsPart = Object.keys(extraOptions).reduce((curr, next) => {
        return `${curr} -${next} ${extraOptions[next]}`
    }, "")

    const outputFilename = `output.${mapShaperFormatToMimeMap[targetFormat].extension}`

    const command = `-i ${processableFilenames.join(" ")} ${extraOptionsPart} -o ${outputFilename}`
    const transformedData: mapShaperOutput = await mapshaper.applyCommands(
        command,
        fileBuffers,
    )

    return transformedData[outputFilename]
}

Route.post('/shp-to-geojson', async ({request, response}) => {
    const payload = await request.validate({
        schema: schema.create({
            file: schema.file({ extnames: ["zip", "geojson", "shp", "prj"] }),
            targetFormat: schema.enum([
                "shapefile", "geojson", "topojson", "json", "dbf", "csv", "tsv", "svg",
            ] as const),
        })
    })

    if ((payload.file.tmpPath !== undefined) && (payload.file.clientName !== undefined)) {
        try {
            const outputBuffer = await geospatialConvert(payload.file.tmpPath, payload.file.clientName, payload.targetFormat)

            response.header('content-type', mapShaperFormatToMimeMap[payload.targetFormat].mime)
            response.header('content-length', outputBuffer.byteLength)
            response.send(outputBuffer.toString())
        } catch (fileError) {
            return {
                error: {
                    type: 'PROCESSING_ERROR',
                    ...fileError
                },
            }
        }
    } else {
        return {
            error: true, filePath: payload.file.tmpPath
        }
    }
})
