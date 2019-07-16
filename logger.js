
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// define logging handler, with file rotation
const logLevel = process.env.NODE_ENV == 'production' ? 'error' : 'debug';
const logger = winston.createLogger({
    level: logLevel,
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'application-%DATE%.log',
            datePattern: 'YYYY-MM-DD-HH',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        })
    ]
});

module.exports = logger