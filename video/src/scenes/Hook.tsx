import React from "react";
import { Shell } from "../Shell";
import { cue } from "../lib";
import { C, F } from "../theme";
import { Card, Mono, Reveal, Sfx, Typed } from "../ui";

const id = "hook" as const;

const OPTIONS = [
  { label: "Wait", at: cue(id, "wait"), color: C.soft },
  { label: "Replace", at: cue(id, "replace"), color: C.amber },
  { label: "Escalate", at: cue(id, "escalate"), color: C.green },
];

const RISKS = [
  { glyph: "2×", title: "Replace too early", sub: "The first transfer lands too. You have paid the supplier twice.", at: cue(id, "replace too early") },
  { glyph: "IBAN", title: "Trust the email", sub: "“We changed banks.” You have paid a fraudster.", at: cue(id, "trust an email") },
  { glyph: "PAID", title: "Trust the bank", sub: "PAID is a claim, not a fact. You can be wrong for days.", at: cue(id, "trust a bank") },
];

export const Hook: React.FC = () => (
  <Shell id={id} eyebrow="01 · The problem">
    <div style={{ position: "relative", width: 1740, height: 780 }}>
      <Reveal at={8} y={40} style={{ position: "absolute", left: 0, top: 20, width: 760 }}>
        <Card style={{ padding: 34, height: 330 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 30,
                background: C.ink,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: F.display,
                fontSize: 22,
              }}
            >
              NS
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 26 }}>Northwind Supply</div>
              <div style={{ fontFamily: F.mono, fontSize: 18, color: "#5b6270" }}>accounts@northwind-supply.com</div>
            </div>
          </div>
          <Mono size={16} color="#5b6270" style={{ marginTop: 26 }}>
            Subject · Payment ACME-1041 not received
          </Mono>
          <div style={{ marginTop: 16, fontSize: 32, lineHeight: 1.35, fontWeight: 500, minHeight: 130 }}>
            <Typed text="Hi, the transfer never arrived. Can you confirm where it is?" at={22} cps={34} cursor={false} />
          </div>
        </Card>
      </Reveal>

      <div style={{ position: "absolute", left: 0, top: 420, width: 760 }}>
        <Mono size={18} style={{ marginBottom: 18 }}>
          The agent must choose
        </Mono>
        <div style={{ display: "flex", gap: 18 }}>
          {OPTIONS.map((o) => (
            <Reveal key={o.label} at={o.at} y={20} scale={0.9}>
              <div
                style={{
                  width: 230,
                  height: 120,
                  border: `3px solid ${o.color}`,
                  color: o.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: F.display,
                  fontSize: 32,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                {o.label}
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      <div style={{ position: "absolute", left: 860, top: 20, width: 880, display: "flex", flexDirection: "column", gap: 28 }}>
        {RISKS.map((r) => (
          <Reveal key={r.title} at={r.at} x={60} y={0}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 28,
                height: 220,
                padding: "0 34px",
                border: `2px solid ${C.red}`,
                background: "rgba(255,92,108,0.08)",
              }}
            >
              <div
                style={{
                  width: 150,
                  height: 150,
                  background: C.red,
                  color: C.ink,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: F.display,
                  fontSize: r.glyph.length > 2 ? 36 : 58,
                  flex: "none",
                }}
              >
                {r.glyph}
              </div>
              <div>
                <div style={{ fontFamily: F.display, fontSize: 38 }}>{r.title}</div>
                <div style={{ fontSize: 28, color: C.muted, marginTop: 10, lineHeight: 1.3 }}>{r.sub}</div>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
    {OPTIONS.map((o) => (
      <Sfx key={o.label} id="tick" at={o.at} volume={0.5} />
    ))}
    {RISKS.map((r) => (
      <Sfx key={r.title} id="alert" at={r.at} volume={0.35} />
    ))}
  </Shell>
);
