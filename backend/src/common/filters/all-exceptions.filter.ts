import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global exception filter that sanitizes all error responses before sending
 * them to clients.
 *
 * Critical responsibility: never leak raw filesystem paths, Node fs error
 * codes (ENOENT, EACCES, etc.), or internal error messages to the HTTP
 * response body. Full errors are still logged server-side.
 *
 * This is the primary safety net — even if individual controllers or
 * downstream middleware (e.g. @nestjs/serve-static's error wrapper) produce
 * a raw error, nothing sensitive escapes.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /**
   * Patterns that indicate a message contains sensitive internal details
   * (paths, Node fs error codes, etc.) and should be replaced wholesale.
   */
  private static readonly SENSITIVE_PATTERNS: RegExp[] = [
    /ENOENT/i,
    /EACCES/i,
    /EISDIR/i,
    /ENOTDIR/i,
    /EMFILE/i,
    /ENFILE/i,
    /EPERM/i,
    /EBUSY/i,
    /no such file or directory/i,
  ];

  /**
   * Path-like substrings that must be stripped from any message we do
   * decide to surface.
   */
  private static readonly PATH_PATTERNS: RegExp[] = [
    /\/var\/[^\s"']+/g,
    /\/Users\/[^\s"']+/g,
    /\/Volumes\/[^\s"']+/g,
    /\/tmp\/[^\s"']+/g,
    /\/private\/[^\s"']+/g,
    /\/home\/[^\s"']+/g,
    /[A-Z]:\\[^\s"']+/g,
  ];

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // If headers have already been sent (e.g. a stream pipe started before
    // erroring), we can't write a JSON body — just end the response.
    if (response.headersSent) {
      this.logger.warn(
        `Exception after headers sent for ${request?.method} ${request?.url}: ${this.describeError(exception)}`,
      );
      try {
        response.end();
      } catch {
        // ignore
      }
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let rawMessage = 'An unexpected error occurred';
    let errorLabel = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        rawMessage = body;
      } else if (body && typeof body === 'object') {
        const asObj = body as { message?: unknown; error?: unknown };
        if (typeof asObj.message === 'string') {
          rawMessage = asObj.message;
        } else if (Array.isArray(asObj.message)) {
          rawMessage = asObj.message.join(', ');
        }
        if (typeof asObj.error === 'string') {
          errorLabel = asObj.error;
        }
      }
    } else if (exception instanceof Error) {
      rawMessage = exception.message;
    }

    const safeMessage = this.sanitizeMessage(rawMessage, status);

    // Log the full, unsanitized error server-side for debugging.
    this.logger.error(
      `[${request?.method} ${request?.url}] ${status} ${errorLabel}: ${this.describeError(exception)}`,
    );

    response.status(status).json({
      statusCode: status,
      error: errorLabel || this.defaultErrorLabel(status),
      message: safeMessage,
    });
  }

  /**
   * Strip sensitive details from an error message. If the message looks
   * like a raw Node fs error or contains filesystem paths, return a
   * generic replacement keyed to the HTTP status code.
   */
  private sanitizeMessage(message: string, status: number): string {
    if (!message) {
      return this.genericFor(status);
    }

    // If the message contains ENOENT / EACCES / etc., replace wholesale.
    for (const pattern of AllExceptionsFilter.SENSITIVE_PATTERNS) {
      if (pattern.test(message)) {
        return this.genericFor(status);
      }
    }

    // If the message contains anything that looks like an absolute path,
    // strip those path substrings but keep the rest.
    let cleaned = message;
    let hadPath = false;
    for (const pattern of AllExceptionsFilter.PATH_PATTERNS) {
      if (pattern.test(cleaned)) {
        hadPath = true;
        cleaned = cleaned.replace(pattern, '[path]');
      }
    }

    if (hadPath && cleaned.trim().length < 5) {
      return this.genericFor(status);
    }

    return cleaned;
  }

  private genericFor(status: number): string {
    if (status === HttpStatus.NOT_FOUND) {
      return 'Resource not found';
    }
    if (status === HttpStatus.FORBIDDEN) {
      return 'Access denied';
    }
    if (status === HttpStatus.UNAUTHORIZED) {
      return 'Unauthorized';
    }
    if (status === HttpStatus.BAD_REQUEST) {
      return 'Invalid request';
    }
    return 'An unexpected error occurred';
  }

  private defaultErrorLabel(status: number): string {
    if (status >= 500) return 'Internal Server Error';
    if (status === HttpStatus.NOT_FOUND) return 'Not Found';
    if (status === HttpStatus.FORBIDDEN) return 'Forbidden';
    if (status === HttpStatus.UNAUTHORIZED) return 'Unauthorized';
    if (status === HttpStatus.BAD_REQUEST) return 'Bad Request';
    return 'Error';
  }

  private describeError(exception: unknown): string {
    if (exception instanceof Error) {
      return `${exception.name}: ${exception.message}${exception.stack ? `\n${exception.stack}` : ''}`;
    }
    try {
      return JSON.stringify(exception);
    } catch {
      return String(exception);
    }
  }
}
