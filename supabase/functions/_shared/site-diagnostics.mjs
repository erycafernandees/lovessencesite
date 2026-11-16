// Retain public route names and recognisable technical messages only.
export function publicPage(value) {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/, 1)[0].replace(/\/index\.html$/, '/');
  if (path === '/') return path;
  if (/^\/(?:loja|contactos|ocasioes|sobre-nos|checkout|acompanhar-encomenda|politica-de-envio|politica-de-privacidade|termos-de-servico|devolucoes-e-reembolsos|encomenda\/confirmacao|projeto\/orcamento|(?:categorias|ocasioes|produtos)\/[a-z][a-z0-9-]{0,70})\/?$/.test(path)) return path;
  return null;
}

export function technicalMessage(value) {
  if (typeof value !== 'string' || !value) return null;
  const message = value.slice(0, 400).replace(/^Uncaught (?:\(in promise\) )?/, '');
  // Browser diagnostics can quote form values, URLs, tokens or uploaded filenames.
  // Only retain literal messages and conventional JS symbol names.
  const symbol = '[a-zA-Z_$][a-zA-Z_$0-9.]{0,60}';
  const native = new RegExp("^(?:(?:TypeError|ReferenceError|SyntaxError|RangeError|Error): )?(?:" +
    symbol + " is (?:not defined|not a function|null|undefined)|Cannot (?:read|set) properties of (?:null|undefined) \\((?:reading|setting) '" + symbol + "'\\)|Cannot access '" + symbol + "' before initialization|Can't find variable: " + symbol + "|Script error\\.?|Failed to fetch|Load failed|Maximum call stack size exceeded|ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\\.)|HTTP [45][0-9]{2})$");
  if (native.test(message)) return message;
  if (/^(?:checkout-prepare|checkout-session|project-submit|attachment-confirm) HTTP [45][0-9]{2}$/.test(message)) return message;
  if (message === 'TypeError: value is not an object') return message;
  if (/^(?:SyntaxError: )?Unexpected token/.test(message)) return 'SyntaxError: Unexpected token';
  if (/is not an object \(evaluating/.test(message)) return 'TypeError: value is not an object';
  const type = /^(TypeError|ReferenceError|SyntaxError|RangeError|SecurityError|QuotaExceededError|NetworkError|AbortError)(?::|$)/.exec(message);
  return type ? type[1] : 'Error';
}

export function scriptLocation(value) {
  if (typeof value !== 'string') return null;
  return /^(?:inline|site\.js|analytics\.js|commerce\.js|commercial-content\.js|site-error-monitor\.js):[1-9]\d{0,5}:\d{1,6}$/.test(value) ? value : null;
}
