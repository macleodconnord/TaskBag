import pino from 'pino';
import { env, isDev } from '../env';

const redact = ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.secret', '*.token', '*.clientSecret'];

export const loggerOptions: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
  redact,
  ...(isDev ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
};

export const log = pino(loggerOptions);
