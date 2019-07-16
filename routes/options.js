const opts = {
    schema: {
        body: {
            type: "object",
            properties: {
                callbackUrl: {
                    format: "uri"
                },
                downloadUrl: {
                    format: "uri"
                },
                signedS3Url: {
                    format: "uri"
                },
                options: {
                    type: "object",
                    properties: {
                        width: {type: "number", },
                        height: {type: "number"},
                        quality: {type: "number", minimum: 0, maxmimum: 100},
                        outputFormat: {type: "string", enum: ["png", "jpg", "gif"]},
                        orientation: {type: "string", enum: ["landscape", "portrait"], default: "portrait"},
                    }
                }
            },
            required: ["callbackUrl", "downloadUrl", "signedS3Url"]
        },
    }
}

module.exports = opts;