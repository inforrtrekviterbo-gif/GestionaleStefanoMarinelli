import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Radice esplicita: in home esiste un package-lock.json non collegato al
  // progetto; senza questo Next sceglie la root sbagliata e avvisa.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
