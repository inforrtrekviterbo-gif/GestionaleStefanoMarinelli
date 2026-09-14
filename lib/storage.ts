/**
 * Adapter R2 -> Supabase Storage.
 *
 * L'app usava il binding Cloudflare R2 `BUCKET` con `get/put/delete`. Qui si
 * espone lo stesso contratto appoggiandosi a Supabase Storage, cosi' le api
 * route restano quasi invariate.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type R2ObjectBodyLike = {
  body: ReadableStream;
  httpEtag?: string;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type R2BucketLike = {
  get: (key: string) => Promise<R2ObjectBodyLike | null>;
  put: (
    key: string,
    value: ReadableStream,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ) => Promise<unknown>;
  delete: (keys: string | string[]) => Promise<void>;
};

let client: SupabaseClient | null = null;

function serviceClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  client = createClient(url, serviceKey, { auth: { persistSession: false } });
  return client;
}

const bucketName = process.env.SUPABASE_STORAGE_BUCKET ?? "product-photos";

/** Ritorna un oggetto R2-compatibile, o `undefined` se lo storage non e' configurato. */
export function getBucket(): R2BucketLike | undefined {
  const supabase = serviceClient();
  if (!supabase) return undefined;
  const store = supabase.storage.from(bucketName);

  return {
    async get(key) {
      const { data, error } = await store.download(key);
      if (error || !data) return null;
      const contentType = data.type || "application/octet-stream";
      return {
        body: data.stream() as unknown as ReadableStream,
        writeHttpMetadata(headers: Headers) {
          headers.set("Content-Type", contentType);
        },
      };
    },
    async put(key, value, options) {
      const buffer = await new Response(value).arrayBuffer();
      const { error } = await store.upload(key, buffer, {
        contentType: options?.httpMetadata?.contentType,
        cacheControl: options?.httpMetadata?.cacheControl ?? "3600",
        upsert: true,
      });
      if (error) throw error;
      return { key };
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (!list.length) return;
      const { error } = await store.remove(list);
      if (error) throw error;
    },
  };
}
