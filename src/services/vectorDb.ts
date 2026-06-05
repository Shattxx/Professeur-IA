import * as lancedb from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';
import crypto from 'crypto';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { AppSettings, DEFAULT_SETTINGS } from '../constants';
import { evaluate, round, floor } from 'mathjs';

export interface ChunkMetadata {
  source_url: string;
  fetch_date: string;
  content_type: "web";
  site_name: string;
  parent_id?: string;
}

export interface TextChunk {
  id: string;
  text: string;
  vector: number[];
  metadata: ChunkMetadata;
}

export interface ImageChunk {
  id: string;
  image_url: string;
  vector: number[];
  metadata: ChunkMetadata;
}

const DB_PATH = './data/lancedb';
const TEXT_TABLE_NAME = 'web_text_chunks';
const IMAGE_TABLE_NAME = 'web_image_chunks';

export function getManuelsSchema(dimension: number) {
  return new arrow.Schema([
    new arrow.Field('id', new arrow.Utf8(), false),
    new arrow.Field('vector', new arrow.FixedSizeList(dimension, new arrow.Field('item', new arrow.Float32(), true)), false),
    new arrow.Field('content', new arrow.Utf8(), true),
    new arrow.Field('source', new arrow.Utf8(), true),
    new arrow.Field('type', new arrow.Utf8(), true),
    new arrow.Field('hash', new arrow.Utf8(), true),
    new arrow.Field('chunk_hash', new arrow.Utf8(), true),
  ]);
}

export function getTextSchema(dimension: number) {
  return new arrow.Schema([
    new arrow.Field('id', new arrow.Utf8(), false),
    new arrow.Field('text', new arrow.Utf8(), false),
    new arrow.Field('vector', new arrow.FixedSizeList(dimension, new arrow.Field('item', new arrow.Float32(), true)), false),
    new arrow.Field('source_url', new arrow.Utf8(), true),
    new arrow.Field('fetch_date', new arrow.Utf8(), true),
    new arrow.Field('content_type', new arrow.Utf8(), true),
    new arrow.Field('site_name', new arrow.Utf8(), true),
    new arrow.Field('hash', new arrow.Utf8(), true),
    new arrow.Field('type', new arrow.Utf8(), true),
  ]);
}

export function getImageSchema(dimension: number) {
  return new arrow.Schema([
    new arrow.Field('id', new arrow.Utf8(), false),
    new arrow.Field('image_url', new arrow.Utf8(), true),
    new arrow.Field('local_path', new arrow.Utf8(), true),
    new arrow.Field('vector', new arrow.FixedSizeList(dimension, new arrow.Field('item', new arrow.Float32(), true)), false),
    new arrow.Field('alt_text_vector', new arrow.FixedSizeList(dimension, new arrow.Field('item', new arrow.Float32(), true)), true),
    new arrow.Field('alt', new arrow.Utf8(), true),
    new arrow.Field('source_url', new arrow.Utf8(), true),
    new arrow.Field('fetch_date', new arrow.Utf8(), true),
    new arrow.Field('content_type', new arrow.Utf8(), true),
    new arrow.Field('site_name', new arrow.Utf8(), true),
    new arrow.Field('parent_id', new arrow.Utf8(), true),
  ]);
}

let detectedEmbeddingDimension: number | null = null;

// Utility to replace potential lone/unpaired surrogates to keep JSON compliant for llama-server
function cleanWellFormed(str: string): string {
  if (!str) return "";
  if (typeof (str as any).toWellFormed === 'function') {
    return (str as any).toWellFormed();
  }
  // Fallback: replace lone high or low surrogates with spaces
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, " ");
}

// Initialize embedding pipeline for llama.cpp server
async function getEmbeddingsFromLlama(text: string, settings: AppSettings): Promise<number[]> {
  const sanitizedText = cleanWellFormed(text);
  const rawIp = settings?.llamaIp || (settings as any)?.ip || DEFAULT_SETTINGS.llamaIp;
  const llamaPort = settings?.llamaPort || (settings as any)?.port || DEFAULT_SETTINGS.llamaPort;
  const llamaIp = rawIp === "0.0.0.0" ? "127.0.0.1" : rawIp;
  const isLocal = llamaIp === "127.0.0.1" || llamaIp === "localhost";
  
  // Local environment strictly uses port 5001 for CPU-only embedding model
  const portsToTry: string[] = [];
  if (isLocal) {
    portsToTry.push("5001");
  } else {
    portsToTry.push(llamaPort || "5000");
  }

  let lastError: any = null;
  for (const port of portsToTry) {
    try {
      const protocol = port === '443' ? 'https' : 'http';
      const baseApiUrl = `${protocol}://${llamaIp}${port && port !== '443' && port !== '80' ? ':' + port : ''}`;
      
      const endpoints = [
        { url: `${baseApiUrl}/embedding`, payload: { content: sanitizedText }, type: "native" },
        { url: `${baseApiUrl}/v1/embeddings`, payload: { input: sanitizedText, model: "embedding" }, type: "oai" },
        { url: `${baseApiUrl}/v1/embeddings`, payload: { input: sanitizedText }, type: "oai" }
      ];

      for (const ep of endpoints) {
        try {
          const response = await fetch(ep.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ep.payload)
          });

          if (response.ok) {
            const data: any = await response.json();
            let vector: any = null;
            
            if (ep.type === "oai" && data?.data?.[0]?.embedding) {
              vector = data.data[0].embedding;
            } else if (ep.type === "native" && data?.embedding) {
              vector = data.embedding;
            }

            if (vector) {
              // Handle token-level (2D) embeddings when pooling is none
              if (Array.isArray(vector) && vector.length > 0 && Array.isArray(vector[0])) {
                const numTokens = vector.length;
                const dim = vector[0].length;
                console.log(`[VectorDB] Detected 2D token-level embedding array (${numTokens} tokens, dim ${dim}). Performing mean pooling...`);
                const pooled = new Array(dim).fill(0);
                for (let t = 0; t < numTokens; t++) {
                  const tokenVec = vector[t];
                  for (let d = 0; d < dim; d++) {
                    pooled[d] += tokenVec[d] || 0;
                  }
                }
                for (let d = 0; d < dim; d++) {
                  pooled[d] /= numTokens;
                }
                vector = pooled;
              }

              if (Array.isArray(vector) && typeof vector[0] === 'number') {
                detectedEmbeddingDimension = vector.length;
                return vector;
              }
            }
          } else {
            const errText = await response.text().catch(() => "");
            lastError = new Error(`HTTP error ${response.status} from ${ep.url} with payload ${JSON.stringify(ep.payload)}: ${errText}`);
          }
        } catch (innerErr: any) {
          lastError = innerErr;
        }
      }
    } catch (e: any) {
      lastError = e;
    }
  }

  throw lastError || new Error("Failed to reach any embedding endpoint");
}

let cachedDimension: number | null = null;

export async function resolveEmbeddingDimension(): Promise<number> {
  if (cachedDimension !== null) {
    return cachedDimension;
  }
  
  if (detectedEmbeddingDimension !== null) {
    cachedDimension = detectedEmbeddingDimension;
    return cachedDimension;
  }

  // Try to query the local llama server with a dummy text to get the real loaded model dimension
  try {
    const dummyVector = await getEmbeddingsFromLlama("dim_test", {} as any);
    if (dummyVector && dummyVector.length > 0) {
      cachedDimension = dummyVector.length;
      detectedEmbeddingDimension = dummyVector.length;
      console.log(`[VectorDB] Successfully queried loaded model. Detected embedding dimension is: ${cachedDimension}`);
      return cachedDimension;
    }
  } catch (err: any) {
    console.log(`[VectorDB] Embedded server not yet ready/loaded for dimension probing: ${err.message || err}. Checking existing tables...`);
  }

  // Check database tables
  try {
    const db = await lancedb.connect(DB_PATH);
    const tableNames = await db.tableNames();
    for (const name of ["manuels", TEXT_TABLE_NAME, IMAGE_TABLE_NAME]) {
      if (tableNames.includes(name)) {
        const table = await db.openTable(name);
        const rows = await table.query().limit(1).toArray();
        if (rows.length > 0 && rows[0].vector && Array.isArray(rows[0].vector)) {
          const len = rows[0].vector.length;
          if (len > 0) {
            cachedDimension = len;
            detectedEmbeddingDimension = len;
            console.log(`[VectorDB] Found existing table "${name}" with vector dimension: ${len}`);
            return len;
          }
        }
      }
    }
  } catch (e) {
    console.error("[VectorDB] Error fetching existing table dimension:", e);
  }

  // Default fallback dimension based on typical models
  cachedDimension = 2048;
  return 2048;
}

export function generateFallbackEmbedding(text: string, dimension: number): number[] {
  const vector = new Array(dimension).fill(0);
  
  // Clean text and split to words/shingles
  const cleanText = text.toLowerCase().replace(/[^\w\s]/g, "");
  const words = cleanText.split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) {
    vector[0] = 1.0;
    return vector;
  }
  
  // Feature hashing (hashing trick) for words with sine projection
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let charIdx = 0; charIdx < word.length; charIdx++) {
      hash = (hash * 31 + word.charCodeAt(charIdx)) | 0;
    }
    
    const index = Math.abs(hash) % dimension;
    const sign = hash < 0 ? -1 : 1;
    vector[index] += sign * (1.0 + Math.sin(i));
    
    // Distribute hash energy
    const index2 = Math.abs(hash * 17 + 5) % dimension;
    vector[index2] += -sign * 0.5;
  }
  
  // Trigram/sliding window hashes for minor spelling resilience
  for (let i = 0; i < cleanText.length - 2; i++) {
    const trigram = cleanText.substring(i, i + 3);
    let hash = 0;
    for (let charIdx = 0; charIdx < trigram.length; charIdx++) {
      hash = (hash * 31 + trigram.charCodeAt(charIdx)) | 0;
    }
    const index = Math.abs(hash) % dimension;
    const sign = hash < 0 ? -1 : 1;
    vector[index] += sign * 0.2;
  }

  // Normalize with standard L2 norm
  let sumSq = 0;
  for (let i = 0; i < dimension; i++) {
    sumSq += vector[i] * vector[i];
  }
  
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      vector[i] = vector[i] / norm;
    }
  } else {
    vector[0] = 1.0;
  }
  
  return vector;
}

export function sanitizeAndResizeVector(vec: any, expectedDim: number, textFallbackSeed: string): number[] {
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`[VectorDB] Le vecteur retourné n'est pas un tableau valide ou est vide (type: ${typeof vec}).`);
  }

  const result = new Array(expectedDim).fill(0.0);
  let hasValid = false;
  let nanCounter = 0;

  for (let i = 0; i < expectedDim; i++) {
    const val = vec[i];
    if (typeof val === 'number' && Number.isFinite(val) && !Number.isNaN(val)) {
      result[i] = val;
      hasValid = true;
    } else {
      result[i] = 0.0;
      nanCounter++;
    }
  }

  if (nanCounter > 0) {
    console.warn(`[VectorDB] Warning: Remplacement de ${nanCounter} valeurs NaN/infinies/manquantes par 0.0 dans un vecteur de dimension ${expectedDim}.`);
  }

  if (!hasValid) {
    throw new Error(`[VectorDB] Le vecteur ne contient aucune valeur numérique valide.`);
  }

  return result;
}

export async function getEmbeddings(text: string, settings: AppSettings): Promise<number[]> {
  const dim = await resolveEmbeddingDimension();
  const rawVector = await getEmbeddingsFromLlama(text, settings);
  return sanitizeAndResizeVector(rawVector, dim, text);
}

export async function getImageEmbeddings(imageBase64: string, settings: AppSettings): Promise<number[]> {
  const dim = await resolveEmbeddingDimension();
  try {
    const rawIp = settings?.llamaIp || (settings as any)?.ip || DEFAULT_SETTINGS.llamaIp;
    const llamaPort = settings?.llamaPort || (settings as any)?.port || DEFAULT_SETTINGS.llamaPort;
    const llamaIp = rawIp === "0.0.0.0" ? "127.0.0.1" : rawIp;
    const isLocal = llamaIp === "127.0.0.1" || llamaIp === "localhost";
    
    // Local environment strictly uses port 5001 for CPU-only embedding model
    const portsToTry: string[] = [];
    if (isLocal) {
      portsToTry.push("5001");
    } else {
      portsToTry.push(llamaPort || "5000");
    }

    let lastError: any = null;
    let rawVector: any = null;
    for (const port of portsToTry) {
      try {
        const protocol = port === '443' ? 'https' : 'http';
        const baseApiUrl = `${protocol}://${llamaIp}${port && port !== '443' && port !== '80' ? ':' + port : ''}`;
        
        const endpoints = [
          { url: `${baseApiUrl}/embedding`, payload: { content: imageBase64 }, type: "native" },
          { url: `${baseApiUrl}/v1/embeddings`, payload: { input: imageBase64, model: "embedding" }, type: "oai" },
          { url: `${baseApiUrl}/v1/embeddings`, payload: { input: imageBase64 }, type: "oai" }
        ];

        for (const ep of endpoints) {
          try {
            const response = await fetch(ep.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(ep.payload)
            });

            if (response.ok) {
              const data: any = await response.json();
              let vector: any = null;
              
              if (ep.type === "oai" && data?.data?.[0]?.embedding) {
                vector = data.data[0].embedding;
              } else if (ep.type === "native" && data?.embedding) {
                vector = data.embedding;
              }

              if (vector) {
                // Handle 2D token embeddings when pooling: none
                if (Array.isArray(vector) && vector.length > 0 && Array.isArray(vector[0])) {
                  const numTokens = vector.length;
                  const tokenDim = vector[0].length;
                  console.log(`[VectorDB] Vision: Detected 2D token-level image embedding array (${numTokens} tokens, dim ${tokenDim}). Performing mean pooling...`);
                  const pooled = new Array(tokenDim).fill(0);
                  for (let t = 0; t < numTokens; t++) {
                    const tokenVec = vector[t];
                    for (let d = 0; d < tokenDim; d++) {
                      pooled[d] += tokenVec[d] || 0;
                    }
                  }
                  for (let d = 0; d < tokenDim; d++) {
                    pooled[d] /= numTokens;
                  }
                  vector = pooled;
                }

                if (Array.isArray(vector) && typeof vector[0] === 'number') {
                  detectedEmbeddingDimension = vector.length;
                  rawVector = vector;
                  break;
                }
              }
            } else {
              const errText = await response.text().catch(() => "");
              lastError = new Error(`HTTP ${response.status} from ${ep.url}: ${errText}`);
            }
          } catch (e: any) {
            lastError = e;
          }
        }
        if (rawVector) break;
      } catch (e: any) {
        lastError = e;
      }
    }

    if (!rawVector) {
      throw lastError || new Error("Unable to contact embedding endpoints");
    }
    return sanitizeAndResizeVector(rawVector, dim, imageBase64.substring(0, 100));
  } catch (e: any) {
    console.error(`[VectorDB] Vision image embedding failed: ${e?.message || e}`);
    throw e;
  }
}

export function sanitizeEmojisAndSymbols(text: string): string {
  if (!text) return "";
  
  let sanitized = text;
  try {
    // Replace various emojis, symbols, emoticons, and pictographs with spaces
    sanitized = sanitized.replace(/[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F7FF}\u{1F800}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{E000}-\u{F8FF}\u{FE00}-\u{FE0F}]/gu, " ");
  } catch (err) {
    // Fallback if environment doesn't support advanced unicode search
    console.warn("[VectorDB-Sanitize] Regexp unicode block failed, using fallback regex.");
    sanitized = sanitized.replace(/[\u2600-\u27BF]/g, " ");
  }
  
  // Clear out general surrogate pairs or loose isolated high/low surrogates which crash Arrow/LanceDB
  try {
    sanitized = sanitized.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, " "); // Complete surrogates
    sanitized = sanitized.replace(/[\uD800-\uDFFF]/g, " "); // Isolated surrogates
  } catch (err) {}

  // Remove excessive whitespace to keep chunking extremely clean
  sanitized = sanitized.replace(/[ \t]+/g, " ");

  return sanitized;
}

export function chunkText(text: string, chunkSize: number = 512, overlap: number = 64): string[] {
  const cleanText = sanitizeEmojisAndSymbols(text);
  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }
  const chunks: string[] = [];
  let start = 0;
  const parsedOverlap = overlap < 1 ? Math.floor(chunkSize * overlap) : overlap;
  const step = Math.max(1, chunkSize - parsedOverlap);

  while (start < cleanText.length) {
    const end = start + chunkSize;
    const chunk = cleanText.slice(start, end);
    if (chunk.trim()) {
      chunks.push(chunk);
    }
    start += step;
    if (end >= cleanText.length) {
      break;
    }
  }

  return chunks;
}

export function getUrlHash(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex');
}

export async function initDb() {
  const db = await lancedb.connect(DB_PATH);
  return db;
}

export async function isUrlIndexed(url: string): Promise<boolean> {
  const db = await initDb();
  try {
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TEXT_TABLE_NAME)) return false;
    
    const table = await db.openTable(TEXT_TABLE_NAME);
    const results = await table.query()
      .where(`source_url = '${url}'`)
      .limit(1)
      .toArray();
    
    return results.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureVectorIndexOnTable(tableToIndex: lancedb.Table, col: string = "vector") {
  try {
    const rowCount = await tableToIndex.countRows();
    console.log(`[VectorDB-Indexation] Creating/Updating HNSW-SQ vector index on column "${col}" for ${rowCount} rows...`);
    await tableToIndex.createIndex(col, {
      config: lancedb.Index.hnswSq(),
      replace: true
    });
    console.log(`[VectorDB-Indexation] Vector index (HNSW-SQ) on "${col}" created/updated successfully for ${rowCount} rows.`);
  } catch (err: any) {
    console.log(`[VectorDB-Indexation] Vector index creation skipped or failed on column "${col}":`, err.message || err);
  }
}

export async function indexWebPage(
  url: string,
  title: string,
  markdown: string,
  siteName: string,
  images: { url: string; alt: string }[],
  settings: AppSettings,
  onProgress: (progress: number) => void
) {
  const db = await initDb();
  const fetchDate = new Date().toISOString();

  const chunks = chunkText(markdown);
  const totalSteps = chunks.length + images.length;
  let completedSteps = 0;

  const textRecords: any[] = [];
  
  // Calculate content hash AFTER extraction/processing
  const contentHash = crypto.createHash('md5').update(markdown).digest('hex');

  // Add Chunk Records
  for (const chunk of chunks) {
    const vector = await getEmbeddings(chunk, settings);
    const id = crypto.randomUUID();
    textRecords.push({
      id,
      text: chunk,
      vector,
      source_url: url,
      fetch_date: fetchDate,
      content_type: 'web',
      site_name: siteName,
      hash: contentHash,
      type: 'chunk'
    });
    completedSteps++;
    onProgress(Number(round((completedSteps / totalSteps) * 100)));
  }

  if (textRecords.length > 0) {
    let table;
    const tableNames = await db.tableNames();
    const dim = await resolveEmbeddingDimension();
    if (tableNames.includes(TEXT_TABLE_NAME)) {
      table = await db.openTable(TEXT_TABLE_NAME);
      try {
        await table.add(textRecords);
      } catch (err: any) {
        if (err.message?.includes("dimension") || err.message?.includes("schema") || err.message?.includes("NaN") || err.message?.includes("Vector")) {
          // Drop and recreate table if dimensions mismatch or NaN errors are encountered
          console.warn("[VectorDB] Text Table schema mismatch or corruption, recreation needed...", err.message);
          await db.dropTable(TEXT_TABLE_NAME);
          table = await db.createTable(TEXT_TABLE_NAME, textRecords, { schema: getTextSchema(dim) });
        } else {
          throw err;
        }
      }
    } else {
      table = await db.createTable(TEXT_TABLE_NAME, textRecords, { schema: getTextSchema(dim) });
    }
    await ensureVectorIndexOnTable(table, "vector");
  }

  const imageRecords: any[] = [];
  const cacheDir = path.join(process.cwd(), 'data', 'image_cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  for (const img of images) {
    try {
      const imgResp = await fetch(img.url);
      if (!imgResp.ok) continue;
      const buffer = await imgResp.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      const vector = await getImageEmbeddings(base64, settings);
      const altTextVector = await getEmbeddings(img.alt || title, settings);
      
      const imgHash = crypto.createHash('md5').update(img.url).digest('hex');
      const ext = path.extname(new URL(img.url).pathname) || '.png';
      const localPath = path.join(cacheDir, `${imgHash}${ext}`);
      fs.writeFileSync(localPath, Buffer.from(buffer));

      const parentId = textRecords[0]?.id;

      imageRecords.push({
        id: crypto.randomUUID(),
        image_url: img.url,
        local_path: localPath,
        vector, 
        alt_text_vector: altTextVector, 
        alt: img.alt || '',
        source_url: url,
        fetch_date: fetchDate,
        content_type: 'web',
        site_name: siteName,
        parent_id: parentId
      });
    } catch (e) {
      console.error(`Failed to index image ${img.url}:`, e);
    }
    completedSteps++;
    onProgress(Number(round((completedSteps / totalSteps) * 100)));
  }

  if (imageRecords.length > 0) {
    let table;
    const tableNames = await db.tableNames();
    const dim = await resolveEmbeddingDimension();
    if (tableNames.includes(IMAGE_TABLE_NAME)) {
      table = await db.openTable(IMAGE_TABLE_NAME);
      try {
        await table.add(imageRecords);
      } catch (err: any) {
        if (err.message?.includes("dimension") || err.message?.includes("schema") || err.message?.includes("NaN") || err.message?.includes("Vector")) {
          console.warn("[VectorDB] Image Table schema mismatch or corruption, recreation needed...", err.message);
          await db.dropTable(IMAGE_TABLE_NAME);
          table = await db.createTable(IMAGE_TABLE_NAME, imageRecords, { schema: getImageSchema(dim) });
        } else {
          throw err;
        }
      }
    } else {
      table = await db.createTable(IMAGE_TABLE_NAME, imageRecords, { schema: getImageSchema(dim) });
    }
    await ensureVectorIndexOnTable(table, "vector");
    try {
      await ensureVectorIndexOnTable(table, "alt_text_vector");
    } catch (e) {}
  }
}

export async function searchVectorDb(query: string, settings: AppSettings, limit: number = 5) {
  const db = await initDb();
  const queryVector = await getEmbeddings(query, settings);
  const results: any[] = [];

  const tableNames = await db.tableNames();
  
  // Search Web Text
  if (tableNames.includes(TEXT_TABLE_NAME)) {
    try {
      const textTable = await db.openTable(TEXT_TABLE_NAME);
      const chunkResults = await textTable.search(queryVector).limit(limit).toArray();

      results.push(...chunkResults.map(r => ({
        ...r,
        type: 'web_chunk',
        source: r.site_name || r.source_url
      })));
    } catch (e) {
      console.warn(`[Search] Failed to search ${TEXT_TABLE_NAME}:`, e);
    }
  }

  // Search Web Images by Alt Text cross-modal search
  if (tableNames.includes(IMAGE_TABLE_NAME)) {
    try {
      const imageTable = await db.openTable(IMAGE_TABLE_NAME);
      const imageResults = await imageTable.search(queryVector, "alt_text_vector").limit(limit).toArray();
      results.push(...imageResults.map(r => ({
        ...r,
        content: `[IMAGE] ${r.alt || 'Image sans description'}`,
        text: `[IMAGE] ${r.alt || 'Image sans description'}`,
        type: 'web_image',
        source: r.site_name || r.source_url
      })));
    } catch (e) {
      console.warn(`[Search] Failed to search ${IMAGE_TABLE_NAME} by alt text:`, e);
    }
  }

  // Search Manuels (Local Files)
  if (tableNames.includes('manuels')) {
    try {
      const manuelsTable = await db.openTable('manuels');
      const manuelResults = await manuelsTable.search(queryVector).limit(limit).toArray();
        
      results.push(...manuelResults.map(r => ({
        ...r,
        type: 'manuel_chunk',
        source: r.source
      })));
    } catch (e) {
      console.warn(`[Search] Failed to search manuels:`, e);
    }
  }
  
  return results.sort((a, b) => (a._distance || 0) - (b._distance || 0)).slice(0, limit);
}

export function getDetectedEmbeddingDimension(): number | null {
  return detectedEmbeddingDimension;
}

