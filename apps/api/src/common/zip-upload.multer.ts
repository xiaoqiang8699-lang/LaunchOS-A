import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { diskStorage, memoryStorage } from 'multer';
import { ZIP_INTAKE_LIMITS, mapZipIntakeError } from '@launchos/shared';

export function zipUploadTempRoot(): string {
  return process.env.LAUNCHOS_UPLOAD_ROOT?.trim() || join(tmpdir(), 'launchos-uploads');
}

/** Disk-backed ZIP upload — avoid holding large ZIP buffers in Multer memoryStorage. */
export function createZipMulterOptions() {
  const destination = zipUploadTempRoot();
  mkdirSync(destination, { recursive: true });
  return {
    storage: diskStorage({
      destination: (_req: unknown, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) =>
        cb(null, destination),
      filename: (_req: unknown, _file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) =>
        cb(null, `${randomUUID()}.zip`),
    }),
    limits: {
      fileSize: ZIP_INTAKE_LIMITS.maxZipBytes,
      files: 1,
    },
    fileFilter: (
      _req: unknown,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      if (!/\.zip$/i.test(file.originalname || '')) {
        cb(
          new BadRequestException({
            code: 'SOURCE_ARCHIVE_INVALID',
            message: '仅支持 .zip 文件',
          }) as unknown as Error,
          false,
        );
        return;
      }
      cb(null, true);
    },
  };
}

/** @deprecated Prefer disk storage; kept only for tiny fixtures in unit tests. */
export function createZipMemoryMulterOptions() {
  return {
    storage: memoryStorage(),
    limits: { fileSize: ZIP_INTAKE_LIMITS.maxZipBytes, files: 1 },
  };
}

export function httpExceptionFromZipError(code: string): HttpException {
  const mapped = mapZipIntakeError(code);
  return new HttpException(
    {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.maxBytes != null ? { maxBytes: mapped.maxBytes } : {}),
    },
    mapped.httpStatus === 413 ? HttpStatus.PAYLOAD_TOO_LARGE : mapped.httpStatus,
  );
}

export function isMulterFileTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; message?: string };
  return err.code === 'LIMIT_FILE_SIZE' || err.message === 'File too large';
}
