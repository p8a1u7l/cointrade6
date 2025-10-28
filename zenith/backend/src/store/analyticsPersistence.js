import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '../../data');
const archiveFile = path.join(dataDir, 'analytics-history.ndjson');

async function ensureArchiveFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(archiveFile, fs.constants.F_OK);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(archiveFile, '', 'utf8');
    } else {
      throw error;
    }
  }
}

export async function persistAnalyticsEvent(event) {
  if (!event || typeof event !== 'object') {
    return;
  }
  const record = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  await ensureArchiveFile();
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(archiveFile, line, 'utf8');
}

export async function loadAnalyticsArchive(limit = 1000) {
  try {
    await ensureArchiveFile();
    const contents = await fs.readFile(archiveFile, 'utf8');
    if (!contents.trim()) {
      return [];
    }
    const lines = contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1000;
    const sliceStart = Math.max(lines.length - safeLimit, 0);
    return lines.slice(sliceStart).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export { archiveFile as analyticsArchivePath };
