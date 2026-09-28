/**
 * Orchestrates one discovery run - the CLI and the Electron app both call
 * runCrawl, so they behave the same:
 *
 *  1. launch Chrome (optional proxy), pass Cloudflare once on www.axs.com, then
 *     sit on www.axs.com/robots.txt to call the API from;
 *  2. walk the date range one day at a time through the search API (one query
 *     is capped at 10,000 results - see search.ts);
 *  3. if the API starts refusing (BlockedError), or the page/browser dies
 *     (window closed, crash, reload), relaunch - with a new proxy session if a
 *     proxy is set - and redo the same day, up to `maxSessions` launches;
 *  4. dedupe by eventId (multi-day events show up on several days) and keep
 *     only upcoming events.
 */
import { launch, passCloudflare, type Session } from "./browser.js";
import { BlockedError, crawlWindow, dayWindows, windowLabel, type Window } from "./search.js";
import { isUpcoming, toRow, type EventRow } from "./events.js";

const WARM_URL = "https://www.axs.com/venues";
// The API calls run from a script-less page of the same origin: the /venues page
// reloads itself now and then (seen on the first runs, "Execution context was
// destroyed"), a plain-text robots.txt never does. It is loaded after the warm-up,
// so it shares the Cloudflare clearance.
const FETCH_HOME = "https://www.axs.com/robots.txt";

export interface CrawlOptions {
  start: Date; // first day, UTC midnight
  end: Date; // exclusive: UTC midnight after the last day
  headless?: boolean;
  proxy?: string | null;
  concurrency?: number; // parallel page requests inside one window
  maxSessions?: number;
  log?: (line: string) => void;
}

export interface CrawlResult {
  rows: EventRow[];
  failed: string[]; // windows that could not be fetched completely (not the same as 0 events)
  stats: {
    days: number;
    hits: number;
    unique: number;
    upcoming: number;
    reportedTotal: number;
    requests: number;
    sessions: number;
    seconds: number;
  };
}

async function openSession(o: Required<CrawlOptions>, used: { n: number }): Promise<Session> {
  while (used.n < o.maxSessions) {
    used.n++;
    const s = await launch(o.headless, o.proxy);
    o.log(`session ${used.n}/${o.maxSessions}: ${s.proxySession ? `proxy session ${s.proxySession}` : "no proxy"}`);
    if (await passCloudflare(s.page, WARM_URL)) {
      const r = await s.page.goto(FETCH_HOME, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      if (r && r.status() === 200) return s;
      o.log(`  !! ${FETCH_HOME} answered ${r ? r.status() : "nothing"} after the warm-up`);
    } else {
      o.log(`  !! Cloudflare did not clear on ${WARM_URL}`);
    }
    await s.browser.close().catch(() => {});
    if (!o.proxy) break; // same IP again would hit the same challenge
  }
  throw new Error(`could not pass Cloudflare on www.axs.com after ${used.n} session(s)` +
    (o.proxy ? "" : " - the machine IP is challenged; try --proxy"));
}

export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  const o: Required<CrawlOptions> = {
    headless: false, proxy: null, concurrency: 4, maxSessions: 5, log: (l) => console.error(l), ...opts,
  };
  const t0 = Date.now();
  const used = { n: 0 };
  const days = dayWindows(o.start, o.end);
  const byId = new Map<number, EventRow>();
  const failed: string[] = [];
  let hits = 0, reportedTotal = 0;
  const requests = { n: 0 };

  // The first session must work (nothing read yet). A later one that fails ends the run
  // early instead of throwing: the days already read are returned (and synced by the app),
  // the rest are listed as failed windows. Seen on Windows 2026-09-28: 25 days / ~29,000
  // events read, then the IP was rate-limited and the whole run was thrown away.
  let session: Session | null = await openSession(o, used);
  try {
    for (let i = 0; i < days.length; i++) {
      const day: Window = days[i];
      let parts;
      try {
        parts = await crawlWindow(session!.page, day, o.concurrency, requests, o.log);
      } catch (err) {
        // Blocked by AXS, or the page/browser died: window closed or crashed (seen on
        // a 365-day run, 2026-09-26) or the page reloaded mid-batch. -> new session, same day.
        const pageDied = /has been closed|Target closed|browser has disconnected|context was destroyed/i.test(String(err));
        if (!(err instanceof BlockedError) && !pageDied) throw err;
        o.log(`  !! ${windowLabel(day)}: ${err instanceof Error ? err.message.split("\n")[0] : err} - new session`);
        await session!.browser.close().catch(() => {});
        session = null;
        try {
          session = await openSession(o, used);
        } catch (openErr) {
          o.log(`  !! stopping early, keeping the ${i} day(s) already read: ${openErr instanceof Error ? openErr.message : openErr}`);
          for (let k = i; k < days.length; k++) failed.push(`${windowLabel(days[k])} (not read: no working session left)`);
          break;
        }
        i--; // redo the same day
        continue;
      }
      let dayHits = 0, dayTotal = 0;
      for (const p of parts) {
        dayHits += p.hits.length;
        dayTotal += p.total;
        if (p.failedPages) failed.push(`${windowLabel(p.window)} (${p.failedPages} page(s) failed)`);
        if (p.capped) failed.push(`${windowLabel(p.window)} (still ${p.total}+ results in one hour - only the first 10,000 read)`);
        for (const h of p.hits) byId.set(h.eventId, toRow(h));
      }
      hits += dayHits;
      reportedTotal += dayTotal;
      o.log(`${day.start.toISOString().slice(0, 10)}: ${dayHits}/${dayTotal} hits, ${byId.size} unique so far`);
    }
  } finally {
    if (session) await session.browser.close().catch(() => {});
  }

  const now = new Date().toISOString().slice(0, 19) + "Z";
  const rows = [...byId.values()]
    .filter((r) => isUpcoming(r, now))
    .sort((a, b) => (a.eventDatetimeUtc ?? "").localeCompare(b.eventDatetimeUtc ?? "") || a.eventId - b.eventId);
  return {
    rows,
    failed,
    stats: {
      days: days.length, hits, unique: byId.size, upcoming: rows.length, reportedTotal, requests: requests.n,
      sessions: used.n, seconds: Math.round((Date.now() - t0) / 1000),
    },
  };
}
