const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

let verbose = false;

function timestamp() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function setVerbose(v) {
  verbose = v;
}

function info(msg) {
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${msg}`);
}

function success(msg) {
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.green}${msg}${COLORS.reset}`);
}

function warn(msg) {
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}${msg}${COLORS.reset}`);
}

function error(msg) {
  console.error(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.red}${msg}${COLORS.reset}`);
}

function debug(msg) {
  if (verbose) {
    console.log(`${COLORS.dim}[${timestamp()}] ${msg}${COLORS.reset}`);
  }
}

function header(msg) {
  console.log(`\n${COLORS.cyan}${'='.repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.cyan}  ${msg}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${'='.repeat(60)}${COLORS.reset}\n`);
}

function table(rows) {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))
  );
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const formatRow = row =>
    keys.map((k, i) => ` ${String(row[k] ?? '').padEnd(widths[i])} `).join('|');

  console.log(formatRow(Object.fromEntries(keys.map(k => [k, k.toUpperCase()]))));
  console.log(sep);
  rows.forEach(r => console.log(formatRow(r)));
}

export { setVerbose, info, success, warn, error, debug, header, table, COLORS };
