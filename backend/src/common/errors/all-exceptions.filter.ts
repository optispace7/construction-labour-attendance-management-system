import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './app.exception';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      type: 'https://clams/errors/internal',
      title: 'Internal server error',
      status,
      code: 'INTERNAL',
    };

    if (exception instanceof AppException) {
      status = exception.getStatus();
      body = {
        type: exception.type,
        title: exception.title,
        status,
        code: exception.code,
        detail: exception.detail,
        meta: exception.meta,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      const message = typeof resp === 'string' ? resp : (resp as { message?: unknown }).message;
      // ValidationPipe reports one message per failed field, as an array. Join
      // them into `detail` as well as `meta.errors`: clients show `detail`, and
      // leaving it empty surfaced the bare class name ("BadRequestException")
      // instead of telling the user which field was wrong.
      const detail = Array.isArray(message)
        ? message.filter((m): m is string => typeof m === 'string').join('; ')
        : (message as string);
      body = {
        type: `https://clams/errors/http-${status}`,
        title: exception.name,
        status,
        code: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR',
        detail: detail || undefined,
        meta: Array.isArray(message) ? { errors: message } : undefined,
      };
    } else {
      // The stack, not just the message. An unexpected error is the one case
      // where the log is all there is to go on, and "ReferenceError: __dirname
      // is not defined" without a frame under it says nothing about which of
      // the bundled libraries reached for it.
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : exception,
      );
    }

    body.instance = req.originalUrl;
    body.requestId = requestId;

    res.status(status).type('application/problem+json').send(body);
  }
}
