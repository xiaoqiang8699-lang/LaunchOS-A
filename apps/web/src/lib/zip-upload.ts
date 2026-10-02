/** Keep web ZIP limit aligned with API ZIP_SOURCE_MAX_BYTES (1200MB). */
export const ZIP_SOURCE_MAX_BYTES = 1200 * 1024 * 1024;

export function formatZipSizeMb(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0';
  return (bytes / (1024 * 1024)).toFixed(digits);
}

export function zipTooLargeMessage(file: { name: string; size: number }): string {
  return [
    '压缩包过大',
    `当前文件：${formatZipSizeMb(file.size)} MB`,
    `LaunchOS 当前支持最大：${formatZipSizeMb(ZIP_SOURCE_MAX_BYTES, 0)} MB`,
    '建议删除 node_modules、.next、dist、build 等构建产物后重新压缩。',
  ].join('\n');
}

export function mapZipUploadError(payload: {
  status: number;
  message?: string;
  code?: string;
  maxBytes?: number;
  fileSize?: number;
}): string {
  const code = payload.code || '';
  const raw = String(payload.message || '');
  if (
    code === 'SOURCE_ARCHIVE_TOO_LARGE' ||
    payload.status === 413 ||
    /file too large|LIMIT_FILE_SIZE|Payload Too Large|Request Entity Too Large/i.test(raw)
  ) {
    const max = payload.maxBytes ?? ZIP_SOURCE_MAX_BYTES;
    const lines = [
      '上传失败',
      '代码压缩包超过 LaunchOS 当前允许的大小。',
      `最大：${formatZipSizeMb(max, 0)} MB`,
    ];
    if (payload.fileSize != null) {
      lines.splice(2, 0, `当前：${formatZipSizeMb(payload.fileSize)} MB`);
    }
    return lines.join('\n');
  }
  if (code === 'SOURCE_ARCHIVE_TOO_MANY_FILES') {
    return '压缩包内文件数量过多，请精简后再上传。';
  }
  if (code === 'SOURCE_ARCHIVE_EXTRACT_TOO_LARGE') {
    return '解压后内容过大，请删除构建产物后重新压缩。';
  }
  if (code === 'SOURCE_ARCHIVE_INVALID' || code === 'SOURCE_ARCHIVE_EMPTY') {
    return raw || 'ZIP 文件无效，请重新选择。';
  }
  if (/file too large/i.test(raw)) {
    return `上传失败\n代码压缩包超过 LaunchOS 当前允许的大小。\n最大：${formatZipSizeMb(ZIP_SOURCE_MAX_BYTES, 0)} MB`;
  }
  return raw || '上传代码失败，请稍后重试。';
}
