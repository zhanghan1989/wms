import { randomUUID } from 'crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.use((req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => {
    const requestIdHeader = req.headers as Record<string, unknown>;
    const requestId = typeof requestIdHeader['x-request-id'] === 'string'
      ? requestIdHeader['x-request-id']
      : randomUUID();
    req.requestId = requestId;
    (res.setHeader as (name: string, value: string) => void)('x-request-id', requestId);
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
