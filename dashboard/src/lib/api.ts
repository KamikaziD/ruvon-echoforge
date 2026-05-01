const BASE = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "http://localhost:8765";

export async function pushPHIC(config: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/v1/phic/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(`PHIC push failed: ${r.status}`);
  return r.json();
}

export async function triggerFreeze() {
  const r = await fetch(`${BASE}/api/v1/phic/freeze`, { method: "POST" });
  if (!r.ok) throw new Error(`Freeze failed: ${r.status}`);
  return r.json();
}

export async function thawFreeze() {
  const r = await fetch(`${BASE}/api/v1/phic/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emergency_freeze: false }),
  });
  if (!r.ok) throw new Error(`Thaw failed: ${r.status}`);
  return r.json();
}

export async function fetchPHIC() {
  const r = await fetch(`${BASE}/api/v1/phic/config`);
  if (!r.ok) throw new Error(`PHIC fetch failed: ${r.status}`);
  return r.json();
}
