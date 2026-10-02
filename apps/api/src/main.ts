import './env';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { requireJwtSecret } from './env';

async function bootstrap(): Promise<void> {
  requireJwtSecret();

  // bodyParser:false + explicit parsers so Alipay notify (x-www-form-urlencoded) is accepted.
  // Use NestExpressApplication (not direct `express` import) — pnpm does not hoist express into apps/api.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3001);
  const host = process.env.API_HOST?.trim();
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
  console.log(`LaunchOS API listening on http://${host || 'localhost'}:${port}`);
}

void bootstrap();
