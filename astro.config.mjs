import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

function safeGit(cmd, fallback) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

function versionManifest() {
  return {
    name: 'inject-version-manifest',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const manifest = {
          tag: process.env.RELEASE_TAG ?? 'dev',
          commit_sha: process.env.RELEASE_COMMIT_SHA ?? safeGit('git rev-parse HEAD', 'unknown'),
          commit_date:
            process.env.RELEASE_COMMIT_DATE ??
            safeGit('git log -1 --format=%cI', new Date().toISOString()),
          build_date: process.env.RELEASE_BUILD_DATE ?? new Date().toISOString(),
        };
        const outDir = fileURLToPath(dir);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
      },
    },
  };
}

// Emits `dist/headers.json` — a flat object mapping HTTP header names to their values.
// Consumed by the `ade-arena-infra` workflow, which feeds it as the `security_headers`
// Terraform variable into a Bunny.net `bunnynet_pullzone_edgerule` that injects the
// headers verbatim at the edge. The Content-Security-Policy `connect-src` is tightened
// to the actual Supabase host instead of a `*.supabase.co` wildcard. Falls back to the
// wildcard when PUBLIC_SUPABASE_URL is unset (e.g. local build with no env), keeping
// the build green while logging a warning.
function securityHeaders() {
  return {
    name: 'emit-security-headers',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const supabaseUrl = process.env.PUBLIC_SUPABASE_URL ?? '';
        let supabaseOrigin = '';
        try {
          if (supabaseUrl) supabaseOrigin = new URL(supabaseUrl).origin;
        } catch {
          // ignore — handled by the empty-origin branch below
        }

        const httpHost = supabaseOrigin || 'https://*.supabase.co';
        const wsHost = supabaseOrigin
          ? supabaseOrigin.replace(/^https?:\/\//, 'wss://')
          : 'wss://*.supabase.co';

        if (!supabaseOrigin) {
          console.warn(
            '[security-headers] PUBLIC_SUPABASE_URL is unset — CSP connect-src falls back to https://*.supabase.co.',
          );
        }

        // CSP backs ADR 001: the JWT lives in localStorage, so the directive is the
        // last line of defence against XSS-driven account takeover.
        //
        // - `style-src 'self'` blocks injected <style> blocks (the only realistic
        //   CSS exfil vector via attribute-selector + background:url tricks).
        // - `style-src-attr 'unsafe-inline'` keeps inline `style="..."` attributes
        //   working (Astro server-rendered width bars, Svelte progress fills).
        //   Attribute styles have no selector context and cannot exfil.
        // - `connect-src` and `form-action` point at the actual Supabase host when
        //   known, otherwise the platform-wide wildcard as a safe fallback.
        const csp = [
          "default-src 'self'",
          "script-src 'self'",
          // Fonts are self-hosted (see Base.astro), so no third-party CSS
          // host needs to be allowed for stylesheets or font files anymore.
          "style-src 'self'",
          "style-src-elem 'self'",
          "style-src-attr 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' https://avatars.githubusercontent.com data:",
          `connect-src 'self' ${httpHost} ${wsHost}`,
          "frame-ancestors 'none'",
          "base-uri 'self'",
          `form-action 'self' ${httpHost}`,
          "object-src 'none'",
          'upgrade-insecure-requests',
        ].join('; ');

        // Canonical HTTP header names — case matters for the downstream Terraform
        // consumer (`jq` in the infra workflow), which does not normalize keys.
        const headers = {
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          'X-Frame-Options': 'DENY',
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
        };

        const outDir = fileURLToPath(dir);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'headers.json'), JSON.stringify(headers, null, 2) + '\n');
      },
    },
  };
}

export default defineConfig({
  integrations: [svelte(), versionManifest(), securityHeaders()],
  site: process.env.PUBLIC_SITE_URL ?? 'https://ade-arena-dev.b-cdn.net',
});
