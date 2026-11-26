import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Execute the actual Edge Function with isolated, in-memory external services.
// No network, database credentials, email or payment provider are used.
export async function loadFunction(name, { client, stripe = {}, env = {}, transform, StripeSDK } = {}) {
  let handler;
  class Stripe {
    constructor() { return stripe; }
    static createFetchHttpClient() { return {}; }
    static createSubtleCryptoProvider() { return {}; }
  }
  const context = vm.createContext({
    Request, Response, Headers, URL, FormData, Blob, Uint8Array, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, btoa, atob, console: { error() {}, log() {} },
    fetch() { throw new Error('Network is disabled in security tests'); },
    Deno: {
      env: { get: key => ({ SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake', STRIPE_SECRET_KEY: 'fake', ...env })[key] },
      serve: value => { handler = value; },
    },
  });
  const cache = new Map();
  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    let module;
    if (path.startsWith('jsr:') || path.startsWith('npm:')) {
      const values = path.startsWith('jsr:') ? { createClient: () => client, SupabaseClient: class {} } : { default: StripeSDK || Stripe };
      module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context, identifier: path });
    } else {
      let source = await readFile(path, 'utf8');
      if (transform) source = transform(source, path);
      module = new vm.SourceTextModule(path.endsWith('.ts') ? stripTypeScriptTypes(source) : source, { context, identifier: path });
    }
    cache.set(path, module);
    await module.link((specifier, parent) => load(specifier.startsWith('.') ? resolve(dirname(parent.identifier), specifier) : specifier));
    return module;
  }
  const module = await load(resolve(`supabase/functions/${name}/index.ts`));
  await module.evaluate();
  return { handler, core: cache.get(resolve('supabase/functions/_shared/core.ts')).namespace };
}

export function database(resolveQuery) {
  const calls = [];
  return {
    calls,
    async rpc(name) {
      if (name === 'consume_api_rate_limit') return { data: true };
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      const query = { table, operation: 'select', filters: [] };
      const chain = new Proxy({}, { get(_, key) {
        if (key === 'then') return (yes, no) => Promise.resolve().then(() => {
          calls.push(structuredClone(query));
          return resolveQuery(query);
        }).then(yes, no);
        return (...args) => {
          if (['insert', 'update', 'upsert', 'delete'].includes(key)) Object.assign(query, { operation: key, values: args[0] });
          else if (key === 'select') query.columns = args[0];
          else query.filters.push([key, ...args]);
          return chain;
        };
      }});
      return chain;
    },
  };
}

export function post(body, headers = {}) {
  return new Request('https://test.invalid/function', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
