<template>
  <main class="apollo-home">
    <section class="hero-grid" aria-labelledby="hero-title">
      <div class="hero-copy">
        <div class="release-kicker">
          <span class="status-dot" aria-hidden="true"></span>
          L1 release candidate · open source
        </div>

        <h1 id="hero-title">Code at the<br /><span>speed of thought.</span></h1>

        <p class="hero-lede">
          Apollo is a model-agnostic coding agent for your terminal. Bring the provider. Keep the
          context. Approve every side effect.
        </p>

        <div class="hero-actions">
          <a class="primary-action" href="/docs/getting-started/install">
            Read the docs <span aria-hidden="true">↗</span>
          </a>
          <a class="text-action" href="https://github.com/JS-mark/apollo-code">
            View source <span aria-hidden="true">→</span>
          </a>
        </div>

        <div class="install-command" aria-label="Installation command">
          <span class="prompt-mark">$</span>
          <code>npm install --global apollo-code</code>
          <span class="command-note">pre-release</span>
        </div>
      </div>

      <div class="hero-visual" aria-label="Apollo terminal session preview">
        <div class="orbital-ring ring-one"></div>
        <div class="orbital-ring ring-two"></div>
        <div class="terminal-shell">
          <div class="terminal-bar">
            <div class="terminal-controls" aria-hidden="true"><i></i><i></i><i></i></div>
            <span>apollo · ~/workspace</span>
            <span class="terminal-tier">TIER / FULL</span>
          </div>

          <div class="terminal-body">
            <p>
              <span class="term-muted">14:08:31</span>
              <span class="term-accent">apollo</span> analyze the failing test
            </p>
            <p class="term-system">◆ Reading repository context <span>12 files</span></p>
            <p class="term-system">◆ Provider selected <span>anthropic / claude</span></p>
            <p class="term-spacer"></p>
            <p><span class="term-accent">→</span> I found the regression in the stream decoder.</p>
            <p>The final UTF-8 boundary is flushed before the abort state.</p>
            <div class="permission-row">
              <div>
                <small>PERMISSION REQUEST</small>
                <strong>write · src/stream.ts</strong>
              </div>
              <span>review</span>
            </div>
            <p class="term-system">◆ Patch applied <span>+8 −3</span></p>
            <p class="term-system">◆ Tests passed <span>5 / 5</span></p>
            <p class="terminal-cursor"><span class="term-accent">›</span> <i></i></p>
          </div>
        </div>
      </div>
    </section>

    <section class="signal-strip" aria-label="Product principles">
      <p><span>01</span> Any model</p>
      <p><span>02</span> Local context</p>
      <p><span>03</span> Explicit permissions</p>
      <p><span>04</span> Rust sandbox</p>
    </section>

    <section class="control-section" aria-labelledby="control-title">
      <div class="section-intro">
        <span class="eyebrow">THE CONTROL PLANE</span>
        <h2 id="control-title">One agent.<br />No black box.</h2>
      </div>

      <div class="control-copy">
        <p>
          Apollo separates reasoning from execution. Models can propose. The permission layer
          decides. The sandbox contains. Every step stays visible in your terminal.
        </p>
        <a href="/docs/concepts/security-model">Explore the security model →</a>
      </div>

      <div class="architecture-rail" role="img" aria-label="Apollo Code system flow">
        <div class="rail-node rail-user">
          <span>01</span>
          <strong>YOU</strong>
          <small>intent</small>
        </div>
        <div class="rail-line"><i></i></div>
        <div class="rail-node">
          <span>02</span>
          <strong>APOLLO</strong>
          <small>context + loop</small>
        </div>
        <div class="rail-line"><i></i></div>
        <div class="rail-node">
          <span>03</span>
          <strong>ROUTER</strong>
          <small>your provider</small>
        </div>
        <div class="rail-line"><i></i></div>
        <div class="rail-node rail-sandbox">
          <span>04</span>
          <strong>SANDBOX</strong>
          <small>controlled action</small>
        </div>
      </div>
    </section>

    <section class="feature-ledger" aria-labelledby="feature-title">
      <div class="ledger-heading">
        <span class="eyebrow">BUILT FOR THE TERMINAL</span>
        <h2 id="feature-title">The parts that matter<br />are yours.</h2>
      </div>

      <article>
        <span class="feature-index">A / 01</span>
        <h3>Provider-neutral</h3>
        <p>Route through a stable contract. Change the model without changing how you work.</p>
      </article>
      <article>
        <span class="feature-index">A / 02</span>
        <h3>Permission-first</h3>
        <p>Writes, commands, and network access ask before they happen. Denial is a normal path.</p>
      </article>
      <article>
        <span class="feature-index">A / 03</span>
        <h3>Local by default</h3>
        <p>Sessions and diagnostics remain on your machine unless you explicitly opt in.</p>
      </article>
      <article>
        <span class="feature-index">A / 04</span>
        <h3>Open end to end</h3>
        <p>TypeScript orchestration and a Rust safety core. Read it, audit it, extend it.</p>
      </article>
    </section>

    <section class="closing-callout">
      <div>
        <span class="eyebrow">START WITH CONTEXT</span>
        <h2>Your repo.<br />Your rules.</h2>
      </div>
      <div>
        <p>Read the five-minute guide, inspect every permission, and make one small change.</p>
        <a class="primary-action" href="/docs/getting-started/5min-tutorial"
          >Run the first task ↗</a
        >
      </div>
    </section>

    <footer class="apollo-footer">
      <a class="footer-brand" href="/">
        <img src="/apollo-mark.svg" alt="" width="28" height="28" />
        <span>APOLLO CODE</span>
      </a>
      <p>Open source · Apache-2.0 · Telemetry local by default</p>
      <div>
        <a href="/docs/getting-started/install">Docs</a>
        <a href="https://github.com/JS-mark/apollo-code/blob/main/SECURITY.md">Security</a>
        <a href="https://github.com/JS-mark/apollo-code">GitHub</a>
      </div>
    </footer>
  </main>
</template>
