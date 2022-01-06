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
import crypto from "crypto"

const fs = require("fs")
const unzipper = require("unzipper")
const mapshaper = require("mapshaper")
var JSZip = require("jszip")

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
    shapefile: {
        extension: "shp",
        mime: "application/x-esri-shape",
        outputExtension: "zip",
        outputMime: "application/zip"
    },
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
].map(val => `-${val}`)

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

    let inputFiles: Record<string, Buffer | string> = {}

    if (fileMime === "application/zip") {
        inputFiles = await unzip(filepath)

        for (const fileDataKey in inputFiles) {
            if (fileDataKey.endsWith(".prj")) {
                inputFiles[fileDataKey] = inputFiles[fileDataKey].toString()
            }
        }
    } else {
        const fileHandle = await Filesystem.open(filepath, 'r')
        inputFiles[filename] = await fileHandle.readFile()
        await fileHandle.close()
    }

    const fileInputOrders = {
        "prj": 1,
        "dbf": 2,
        "shp": 3,
    }

    const processableFilenames = Object.keys(inputFiles)
        .filter(filename =>
            filename.endsWith(".shp")
            || filename.endsWith(".prj")
            || filename.endsWith(".dbf")
            || filename.endsWith(".json")
        ).sort((a, b) => {
            const extensionA = a.split(".")[1]
            const extensionB = b.split(".")[1]
            return fileInputOrders[extensionA] - fileInputOrders[extensionB]
        })

    const processableFiles = processableFilenames.reduce((curr, next) => {
        return {...curr, [next]: inputFiles[next]}
    }, {})

    const extraOptionsPart = extraOptions
        .map(({option, value}) => `${option} ${value}`)
        .join(' ')

    const outputFilename = `output.${mapShaperFormatToMimeMap[targetFormat].extension}`
    const command = `-i ${processableFilenames.join(" ")} ${extraOptionsPart} -o ${outputFilename}`
    console.info(`COMMAND: ${command}`)

    const transformedData: Record<string, Buffer> = await mapshaper.applyCommands(
        command,
        processableFiles,
    )

    if (Object.keys(transformedData).length > 1) {
        let zip = new JSZip();

        for (const transformedDataKey in transformedData) {
            const buf = transformedData[transformedDataKey]
            zip.file(transformedDataKey, buf)
        }

        return await new Promise((resolve, reject) => {
            const randomZipFilename = `${crypto.randomBytes(20).toString('hex')}.zip`

            zip.generateNodeStream({type: 'nodebuffer', streamFiles: true})
                .pipe(fs.createWriteStream(randomZipFilename))
                .on('error', reject)
                .on('finish', () => {
                    let fh
                    // TODO: Don't use output.zip, use random filenames to support concurrency
                    Filesystem.open(randomZipFilename, "r")
                        .then(fileHandle => {
                            fh = fileHandle
                            return fileHandle.readFile()
                        })
                        .then(buffer => {
                            fh.close()
                            
                            Filesystem.unlink(randomZipFilename)
                                .then(() => {
                                    resolve(buffer)
                                })
                        })
                        .catch(reject)
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
            console.error(fileError)

            return {
                error: {
                    type: fileError.name,
                    message: fileError.message,
                },
            }
        }
    } else {
        return {
            error: true, filePath: payload.file.tmpPath
        }
    }
})
