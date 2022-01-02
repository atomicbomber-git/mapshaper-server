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
import fs, {PathOrFileDescriptor} from "fs"

const mapshaper = require("mapshaper")

const readFileAsync = (path: PathOrFileDescriptor): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
            if (err !== null) {
                reject(err)
            } else {
                resolve(data)
            }
        })
    })
}

interface mapShaperOutput {
    "output.geojson": Buffer
}

Route.post('/shp-to-geojson', async ({request, response}) => {
    const shpFile = request.file("shp_file")

    const filePath = shpFile?.tmpPath

    if (filePath !== undefined) {
        try {
            const fileData = await readFileAsync(filePath)

            const transformedData: mapShaperOutput = await mapshaper.applyCommands(
                `-i input.shp -proj wgs84 -o output.geojson`,
                {'input.shp': fileData},
            )

            response.header('content-type', `application/json`)
            response.header('content-length', transformedData["output.geojson"].byteLength)
            response.send(transformedData["output.geojson"].toString())
        } catch (fileError) {
            return {
                processingError: true,
                error: fileError,
            }
        }
    } else {
        return {error: true, filePath: filePath}
    }
})
