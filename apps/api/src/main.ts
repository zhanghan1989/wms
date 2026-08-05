import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use((
    req: Record<string, unknown>,
    res: Record<string, unknown> & { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    const headers = req.headers as Record<string, unknown> | undefined;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'",
    );
    if (String(headers?.['x-forwarded-proto'] ?? '').toLowerCase() === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  const preferredPublicDir = join(process.cwd(), 'public');
  const fallbackPublicDir = join(process.cwd(), 'apps', 'api', 'public');
  const publicDir = existsSync(preferredPublicDir) ? preferredPublicDir : fallbackPublicDir;
  app.useStaticAssets(publicDir, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  });

  app.setGlobalPrefix('api');
  app.use((
    req: Record<string, unknown>,
    res: Record<string, unknown> & { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    const requestIdHeader = req.headers as Record<string, unknown>;
    const requestId = typeof requestIdHeader['x-request-id'] === 'string'
      ? requestIdHeader['x-request-id']
      : randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
