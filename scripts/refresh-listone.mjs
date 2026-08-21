import { mkdir, readFile, writeFile } from "node:fs/promises";

const SOURCE_URL = "https://www.piccioleague.it/listone/";
const OUTPUT_PATH = "data/listone.json";

function decode(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowsFromTable(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decode(cell[1]))
      .filter(Boolean);
    if (cells.length < 5) continue;

    const roleIndex = cells.findIndex((cell) => /^[PDCA]$/i.test(cell));
    if (roleIndex < 1 || cells.length < roleIndex + 4) continue;

    const name = cells[roleIndex - 1];
    const role = cells[roleIndex].toUpperCase();
    const team = cells[roleIndex + 1];
    const quote = Number(cells[roleIndex + 2].replace(",", "."));
    const marketValue = Number(cells[roleIndex + 3].replace(",", "."));

    if (!name || !team || !Number.isFinite(quote) || quote < 1 || quote > 100) continue;
    rows.push({ name, role, team, quote, marketValue: Number.isFinite(marketValue) ? marketValue : null });
  }
  return rows;
}

function rowsFromEmbeddedJson(html) {
  const rows = [];
  const patterns = [
    /\{[^{}]{0,900}?"(?:name|nome)"\s*:\s*"([^"]+)"[^{}]{0,900}?"(?:role|ruolo)"\s*:\s*"([PDCA])"[^{}]{0,900}?"(?:team|squadra)"\s*:\s*"([^"]+)"[^{}]{0,900}?"(?:quote|quotazione|qtA)"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?[^{}]{0,900}?\}/gi,
    /\{[^{}]{0,900}?"(?:nome|name)"\s*:\s*"([^"]+)"[^{}]{0,900}?"(?:squadra|team)"\s*:\s*"([^"]+)"[^{}]{0,900}?"(?:ruolo|role)"\s*:\s*"([PDCA])"[^{}]{0,900}?"(?:quotazione|quote|qtA)"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?[^{}]{0,900}?\}/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const firstLayout = /^[PDCA]$/i.test(match[2]);
      const name = decode(match[1]);
      const role = (firstLayout ? match[2] : match[3]).toUpperCase();
      const team = decode(firstLayout ? match[3] : match[2]);
      const quote = Number((firstLayout ? match[4] : match[4]).replace(",", "."));
      if (name && team && /^[PDCA]$/.test(role) && Number.isFinite(quote) && quote >= 1 && quote <= 100) {
        rows.push({ name, role, team, quote, marketValue: null });
      }
    }
  }
  return rows;
}

function normalize(rows) {
  const unique = new Map();
  for (const player of rows) {
    const key = `${player.name.toLocaleLowerCase("it")}-${player.role}-${player.team.toLocaleLowerCase("it")}`;
    unique.set(key, player);
  }
  return [...unique.values()].sort((a, b) => b.quote - a.quote || a.name.localeCompare(b.name, "it"));
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "it-IT,it;q=0.9",
      "user-agent": "COMEP-Legends-Data-Refresh/1.0 (public listone sync)"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) throw new Error(`Fonte non disponibile (HTTP ${response.status})`);
  const html = await response.text();
  const players = normalize([...rowsFromTable(html), ...rowsFromEmbeddedJson(html)]);
  if (players.length === 0) {
    console.error(`Diagnostica import: ${html.length} caratteri; tipo=${response.headers.get("content-type") ?? "sconosciuto"}`);
    console.error(html.slice(0, 1200));
  }

  if (players.length < 450 || players.length > 650) {
    const scriptSources = [...html.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map((match) => match[1]).slice(0, 30);
    const apiHints = [];
    await mkdir("data", { recursive: true });
    await writeFile("data/import-status.json", JSON.stringify({
      checkedAt: new Date().toISOString(),
      sourceUrl: SOURCE_URL,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      htmlLength: html.length,
      detectedPlayers: players.length,
      scriptSources,
      apiHints,
      playerLinkCount: (html.match(/\/giocatore\//g) ?? []).length,
      knownPlayerIndex: html.indexOf("Skorupski"),
      knownPlayerContext: (() => {
        const index = html.indexOf("Skorupski");
        return index >= 0 ? html.slice(Math.max(0, index - 240), index + 780) : null;
      })()
    }, null, 2) + "\n");
    throw new Error(`Controllo di sicurezza non superato: trovati ${players.length} calciatori`);
  }

  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: {
      name: "Piccio League – Listone quotazioni",
      url: SOURCE_URL,
      status: "verified-import",
      note: "Fonte gratuita usata come backup tecnico per le quotazioni; il sito mostra sempre data e provenienza."
    },
    playerCount: players.length,
    players
  };

  await mkdir("data", { recursive: true });
  let previous = "";
  try { previous = await readFile(OUTPUT_PATH, "utf8"); } catch {}
  const next = JSON.stringify(payload, null, 2) + "\n";
  if (previous !== next) await writeFile(OUTPUT_PATH, next);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
// Revisione iniziale: importazione attivata dal workflow GitHub.
