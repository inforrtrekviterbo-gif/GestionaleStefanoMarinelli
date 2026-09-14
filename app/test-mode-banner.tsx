"use client";

import { useEffect, useState } from "react";

const COOKIE = "gestionale_mode";

function readTestCookie() {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => c.trim() === `${COOKIE}=test`);
}

/** Helper condiviso: il client (post) legge lo stesso cookie. */
export function isClientTestMode() {
  return readTestCookie();
}

export default function TestModeBanner() {
  const [testMode, setTestMode] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTestMode(readTestCookie());
    setReady(true);
  }, []);

  function toggle() {
    const next = !testMode;
    if (next) {
      // 12 ore, tutto il sito
      document.cookie = `${COOKIE}=test; path=/; max-age=${12 * 3600}; SameSite=Strict`;
    } else {
      document.cookie = `${COOKIE}=; path=/; max-age=0; SameSite=Strict`;
    }
    setTestMode(next);
    window.dispatchEvent(new CustomEvent("gestionale-mode-change", { detail: next ? "test" : "normal" }));
  }

  // Evita flash prima di leggere il cookie
  if (!ready) return null;

  return (
    <div
      role="region"
      aria-label="Modalità dati"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "8px 14px",
        fontSize: 14,
        fontWeight: 600,
        color: testMode ? "#3a2a00" : "#eaf6ff",
        background: testMode ? "#ffb703" : "#0b3550",
        borderBottom: testMode ? "2px solid #d68a00" : "2px solid #12405f",
        letterSpacing: 0.2,
      }}
    >
      <span>
        {testMode
          ? "⚠️ MODALITÀ TEST — nessun dato viene salvato (né database né sincronizzazione)"
          : "● Modalità normale — le operazioni vengono salvate"}
      </span>
      <button
        type="button"
        onClick={toggle}
        style={{
          cursor: "pointer",
          border: "none",
          borderRadius: 999,
          padding: "5px 14px",
          fontWeight: 700,
          fontSize: 13,
          color: testMode ? "#ffb703" : "#0b3550",
          background: testMode ? "#3a2a00" : "#eaf6ff",
        }}
      >
        {testMode ? "Passa a NORMALE" : "Passa a TEST"}
      </button>
    </div>
  );
}
