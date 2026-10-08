const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const { spawn } = await import("node:child_process");
const profile = `${process.env.TEMP}\\yts-cdp-profile`;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=9333",
  "http://127.0.0.1:4173/",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(1200);
const targets = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No Chrome page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || "evaluate failed");
  return result.result?.result?.value;
}

const checks = [];
function check(name, value) {
  checks.push(`${value ? "OK" : "FAIL"} ${name}`);
}

try {
  await sleep(400);
  check("empty url", String(await evaluate(`
    document.querySelector('#video-url').value = '';
    document.querySelector('form.url-row').requestSubmit();
    return document.querySelector('.alert')?.textContent || '';
  `)).includes("Paste a YouTube"));

  check("invalid url", String(await evaluate(`
    document.querySelector('#video-url').value = 'https://example.com/watch?v=nope';
    document.querySelector('form.url-row').requestSubmit();
    return document.querySelector('.alert')?.textContent || '';
  `)).includes("valid YouTube"));

  check("paste transcript", Number(await evaluate(`
    document.querySelector('#video-url').value = '';
    document.querySelector('.paste textarea').value = 'Hello from the studio\\nSecond line about trunks';
    document.querySelector('.paste form').requestSubmit();
    return new Promise((resolve) => setTimeout(() => resolve(document.querySelectorAll('.segment').length), 500));
  `)) >= 2);

  check("search highlight", Number(await evaluate(`
    const input = document.querySelector('input[type=search]');
    input.value = 'trunks';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('mark').length;
  `)) >= 1);

  check("study tab", await evaluate(`
    document.querySelector('[data-tab=study]').click();
    return document.querySelector('#panel-study').hidden === false;
  `) === true);

  check("portuguese", String(await evaluate(`
    const language = document.querySelector('select');
    language.value = 'pt-BR';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelector('form.url-row button[type=submit]').textContent;
  `)).includes("Processar"));

  check("spanish export", String(await evaluate(`
    const language = document.querySelector('select');
    language.value = 'es';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-tab=export]').click();
    return document.querySelector('[data-format=vtt]').textContent;
  `)).includes("Descargar WebVTT"));
} finally {
  console.log(checks.join("\n"));
  ws.close();
  chrome.kill();
}
