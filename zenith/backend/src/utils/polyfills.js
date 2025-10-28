import { Blob as BufferBlob } from 'buffer';

let undici = {};
try {
  const undiciImport = await import('undici');
  undici = undiciImport?.default ?? undiciImport ?? {};
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
    throw error;
  }
  undici = {};
}

const undiciFetch = typeof undici.fetch === 'function' ? undici.fetch : undefined;
const UndiciHeaders = typeof undici.Headers === 'function' ? undici.Headers : undefined;
const UndiciRequest = typeof undici.Request === 'function' ? undici.Request : undefined;
const UndiciResponse = typeof undici.Response === 'function' ? undici.Response : undefined;
const UndiciFormData = typeof undici.FormData === 'function' ? undici.FormData : undefined;
const UndiciFile = typeof undici.File === 'function' ? undici.File : undefined;
const UndiciBlob =
  typeof undici.Blob === 'function'
    ? undici.Blob
    : typeof BufferBlob === 'function'
      ? BufferBlob
      : undefined;

if (typeof globalThis.fetch !== 'function' && undiciFetch) {
  globalThis.fetch = undiciFetch;
}

if (typeof globalThis.Headers !== 'function' && UndiciHeaders) {
  globalThis.Headers = UndiciHeaders;
}

if (typeof globalThis.Request !== 'function' && UndiciRequest) {
  globalThis.Request = UndiciRequest;
}

if (typeof globalThis.Response !== 'function' && UndiciResponse) {
  globalThis.Response = UndiciResponse;
}

if (typeof globalThis.FormData !== 'function' && UndiciFormData) {
  globalThis.FormData = UndiciFormData;
}

if (typeof globalThis.File !== 'function' && UndiciFile) {
  globalThis.File = UndiciFile;
}

if (typeof globalThis.Blob !== 'function' && UndiciBlob) {
  globalThis.Blob = UndiciBlob;
}
