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
var JSZip = require("jszip");

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
    outputExtension?: string,
    outputMime?: string,
}

const mapShaperFormatToMimeMap: Record<string, OutputFormat> = {
    shapefile: {extension: "shp", mime: "application/x-esri-shape", outputExtension: "zip", outputMime: "application/zip"},
    geojson: {extension: "json", mime: "application/json"},
    topojson: {extension: "json", mime: "application/json"},
    json: {extension: "json", mime: "application/json"},
    dbf: {extension: "dbf", mime: "application/dbase"},
    csv: {extension: "csv", mime: "text/csv"},
    tsv: {extension: "tsv", mime: "text/tab-separated-values"},
    svg: {extension: "svg", mime: "image/svg+xml"},
}

const mapShaperOptionNames = [
    "affine", "classify", "clean", "clip", "colorizer",
    "dissolve", "dissolve2", "divide", "dots", "drop",
    "each", "erase", "explode", "filter", "filter-fields",
    "filter-islands", "filter-slivers", "graticule", "grid", "include",
    "inlay", "innerlines", "join", "lines", "merge-layers",
    "mosaic", "point-grid", "points", "polygons", "proj",
    "rectangle", "rectangles", "rename-fields", "rename-layers", "require",
    "run", "shape", "simplify", "sort", "split",
    "split-on-grid", "subdivide", "style", "target", "union", "uniq",
]

interface MapShaperOption {
    option: string
    value: string
}

const geospatialConvert = async (
    filepath: string,
    filename: string,
    targetFormat: string = "geojson",
    extraOptions: MapShaperOption[] = [],
): Promise<Buffer> => {
    const fileType = (await FileType.fromFile(filepath))
    const fileMime = fileType?.mime ?? "text/plain"

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
            filename.endsWith(".shp")
            || filename.endsWith(".prj")
            || filename.endsWith(".json")
        )

    const extraOptionsPart = extraOptions
        .map(({option, value}) => `-${option} ${value}`)
        .join(' ')

    const outputFilename = `output.${mapShaperFormatToMimeMap[targetFormat].extension}`

    const command = `-i ${processableFilenames.join(" ")} -proj wgs84 -o ${extraOptionsPart} ${outputFilename}`


    const transformedData: Record<string, Buffer> = await mapshaper.applyCommands(
        command,
        fileBuffers,
    )

    if (Object.keys(transformedData).length > 1) {
        let zip = new JSZip();

        for (const transformedDataKey in transformedData) {
            const buf = transformedData[transformedDataKey]
            zip.file(transformedDataKey, buf)
        }

        return await new Promise((resolve, reject) => {
            zip.generateNodeStream({type: 'nodebuffer', streamFiles: true})
                .pipe(fs.createWriteStream("output.zip"))
                .on('error', reject)
                .on('finish', () => {
                    let fh
                    Filesystem.open("output.zip", "r")
                        .then(fileHandle => {
                            fh = fileHandle
                            return fileHandle.readFile()
                        })
                        .then(buffer => {
                            fh.close()
                            resolve(buffer)
                        })
                })
        })
    }

    return transformedData[outputFilename]
}

Route.post('/convert', async ({request, response}) => {
    const payload = await request.validate({
        schema: schema.create({
            file: schema.file({extnames: ["zip", "json", "shp"]}),
            targetFormat: schema.enum([
                "shapefile", "geojson", "topojson", "json", "dbf", "csv", "tsv", "svg",
            ] as const),
            options: schema.array.optional().members(
                schema.object().members({
                    option: schema.enum(mapShaperOptionNames),
                    value: schema.string()
                })
            )
        })
    })

    if ((payload.file.tmpPath !== undefined) && (payload.file.clientName !== undefined)) {
        try {
            const outputBuffer = await geospatialConvert(
                payload.file.tmpPath,
                payload.file.clientName.replaceAll(' ', '_').toLowerCase(),
                payload.targetFormat,
                payload.options
            )

            const outputConfig = mapShaperFormatToMimeMap[payload.targetFormat]

            response
                .header('content-type', outputConfig?.outputMime ?? outputConfig.mime)
                .header('content-disposition', `attachment; filename="output.${outputConfig?.outputExtension ?? outputConfig.extension}"`)
                .send(outputBuffer)
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
