---
theme: default
title: "Debug That — Quand Claude apprend à debugger"
info: |
  Meetup Dev With AI — Par Thomas Walter
drawings:
  persist: false
transition: none
codeCopy: false
mdc: true
class: text-center
---

<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
  :root {
    --slidev-theme-primary: #ff512c;
  }
  .slidev-layout {
    background: #faf9f8;
    color: #1d2939;
    font-family: 'Poppins', sans-serif;
  }
  h1, h2, h3 {
    color: #1d2939 !important;
    font-family: 'Poppins', sans-serif;
    font-weight: 700;
  }
  
  .accent { color: #ff512c; }
  .teal { color: #1a9a6b; }
  .blue { color: #2e7dd1; }
  .dim { color: #8f99aa; }
  .big { font-size: 2.5rem; font-weight: 700; line-height: 1.2; }
  .huge { font-size: 4rem; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }
  .mono { font-family: 'JetBrains Mono', monospace; }
  blockquote {
    border-left: 3px solid #ff512c;
    padding-left: 1rem;
    color: #8f99aa;
    font-style: italic;
  }
  .glow {
    text-shadow: 0 0 40px rgba(255, 81, 44, 0.15);
  }
  /* Code blocks */
  .slidev-code-wrapper .shiki {
    background: #1d2939 !important;
    border-radius: 12px;
    padding: 1.5rem;
  }
  .slidev-code-wrapper .shiki .line.highlighted {
    background: rgba(255, 81, 44, 0.15) !important;
  }
  /* Dark slide variant */
  .dark-slide {
    background: #1d2939 !important;
    color: #e9ebef !important;
  }
  .dark-slide h1, .dark-slide h2, .dark-slide h3 {
    color: #fafafa !important;
  }
</style>

<div style="display: flex; align-items: center; gap: 3rem; text-align: left; padding: 0 2rem;">
  <div style="flex: 1;">
    <h1 class="huge glow" style="font-size: 3.5rem;">debug that</h1>
    <p class="dim" style="font-size: 1.2rem; margin-top: 0.5rem;">
      Quand Claude apprend à utiliser un debugger
    </p>
    <div style="margin-top: 2rem; color: #8f99aa; font-size: 0.9rem;">
      Thomas Walter · Dev With AI Meetup
    </div>
  </div>
  <div style="flex: 1; display: flex; justify-content: center;">
    <img src="/terminal-demo.png" style="max-height: 340px; border-radius: 12px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.2);" />
  </div>
</div>

---
layout: two-cols
class: px-8
---

<div style="display: flex; flex-direction: column; justify-content: center; height: 100%;">

<p class="big" style="font-size: 1.8rem;">Thomas Walter</p>

<p class="dim" style="font-size: 1.1rem; margin-top: 0.5rem;">
Partner & CTO Healthtech
</p>

<div style="margin-top: 1.5rem;">
  <img src="/theodo-orange.svg" style="height: 28px;" />
</div>

</div>

::right::

<div style="display: flex; justify-content: center; align-items: center; height: 100%; padding-left: 2rem;">
  <img src="/thomas.jpg" style="width: 240px; height: 240px; border-radius: 50%; object-fit: cover; border: 3px solid #e2e5ea;" />
</div>

---

# Je pensais pas que le debugger passionnait autant

<div style="display: flex; gap: 2rem; margin-top: 1.5rem; align-items: center; justify-content: center;">
  <img src="/post-linkedin.png" style="height: 400px; border-radius: 12px; border: 1px solid #e2e5ea;" />
  <p class="big" style="font-size: 3rem;">
    <span class="accent">110 000</span> vues
  </p>
</div>

---
layout: section
---

# Le problème

---
class: flex flex-col items-center justify-center
---

<div v-click="[0, 2]" style="position: absolute; inset: 2rem; display: flex; align-items: center; justify-content: center;">

```ts
function processOrder(order: Order) {
  const subtotal = order.price * order.qty
  const shipping = order.shipping
  const total = subtotal + shipping

  return { product: order.product, subtotal, shipping, total }
}
```

</div>

<div v-click="[2, 4]" style="position: absolute; inset: 2rem; display: flex; align-items: center; justify-content: center;">

```ts {3,5,7}
function processOrder(order: Order) {
  const subtotal = order.price * order.qty
  console.log("DEBUG subtotal:", subtotal)
  const shipping = order.shipping
  console.log("DEBUG shipping:", shipping, typeof shipping)
  const total = subtotal + shipping
  console.log("DEBUG total:", total)

  return { product: order.product, subtotal, shipping, total }
}
```

</div>

<div v-click="[4, 11]" style="position: absolute; inset: 2rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem;">
  <img v-click="4" src="/claude-1.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="5" src="/claude-2.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="6" src="/claude-3.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="7" src="/claude-4.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="8" src="/claude-5.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="9" src="/claude-6.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
  <img v-click="10" src="/claude-7.png" style="height: 42px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
</div>

---
class: px-12
---

# Le workaround

<div style="display: flex; gap: 2rem; margin-top: 1.5rem; align-items: center;">

<div style="flex: 1;">
  <div style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.2rem;">
    <span style="font-size: 1.5rem; font-weight: 700; color: #ff512c;">1.</span>
    <p style="font-size: 1.1rem;">Je lançais le debugger <span class="dim">moi-même</span></p>
  </div>
  <div style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.2rem;">
    <span style="font-size: 1.5rem; font-weight: 700; color: #ff512c;">2.</span>
    <p style="font-size: 1.1rem;">Je mettais Claude <span class="dim">à côté</span></p>
  </div>
  <div style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.2rem;">
    <span style="font-size: 1.5rem; font-weight: 700; color: #ff512c;">3.</span>
    <p style="font-size: 1.1rem;">Je lui <span class="accent">expliquais</span> ce que je voyais</p>
  </div>
  <div style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.2rem;">
    <span style="font-size: 1.5rem; font-weight: 700; color: #ff512c;">4.</span>
    <p style="font-size: 1.1rem;">Parfois des <span class="accent">screenshots</span> de l'IDE</p>
  </div>
  <p class="dim" style="margin-top: 1.5rem; font-size: 0.95rem;">
    Un genre de copilot de debug. Mais c'est moi qui fais tout le boulot...
  </p>
</div>

<div style="flex: 1;">
  <img src="/ide-debugger.png" style="width: 100%; border-radius: 10px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.15); border: 1px solid #e2e5ea;" />
</div>

</div>

---
class: flex flex-col items-center justify-center
---

<p class="big" style="text-align: center; margin-bottom: 1rem;">
Quelle est la <span class="accent">solution</span> ?
</p>

<div style="position: relative; height: 320px; width: 100%; display: flex; align-items: center; justify-content: center;">

<div v-click="[1, 2]" style="position: absolute; text-align: center;">
  <img src="/yt-prompt.png" style="height: 260px; border-radius: 12px; border: 2px solid #e2e5ea; box-shadow: 0 8px 30px rgba(0,0,0,0.12); transform: rotate(-2deg);" />
</div>

<div v-click="[2, 3]" style="position: absolute; text-align: center;">
  <img src="/yt-context.png" style="height: 260px; border-radius: 12px; border: 2px solid #e2e5ea; box-shadow: 0 8px 30px rgba(0,0,0,0.12); transform: rotate(1.5deg);" />
</div>

<div v-click="[3, 4]" style="position: absolute; text-align: center;">
  <img src="/yt-harness.png" style="height: 260px; border-radius: 12px; border: 2px solid #e2e5ea; box-shadow: 0 8px 30px rgba(0,0,0,0.12); transform: rotate(-1deg);" />
</div>

<div v-click="[4, 5]" style="position: absolute; text-align: center;">
  <img src="/yt-mcp.png" style="height: 260px; border-radius: 12px; border: 2px solid #e2e5ea; box-shadow: 0 8px 30px rgba(0,0,0,0.12); transform: rotate(2deg);" />
</div>

<div v-click="5" style="position: absolute; text-align: center;">
  <img src="/yt-cli.png" style="height: 260px; border-radius: 12px; border: 3px solid #ff512c; box-shadow: 0 8px 30px rgba(255, 81, 44, 0.2); transform: rotate(-1.5deg);" />
  <p class="accent" style="font-size: 1.1rem; margin-top: 0.8rem; font-weight: 600;">Long live the CLI</p>
</div>

</div>

---
class: px-12
---

# Tout comme <span class="accent">agent-browser</span>, mais pour le debugger

<div style="display: flex; align-items: center; justify-content: center; gap: 0.8rem; margin-top: 2rem;">
  <img src="/agent-browser.png" style="height: 180px; border-radius: 10px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.15); border: 1px solid #e2e5ea;" />
  <svg width="80" height="20" viewBox="0 0 80 20"><path d="M0 10h70" stroke="#ff512c" stroke-width="2" stroke-dasharray="5 3" /><path d="M66 5l9 5-9 5" fill="#ff512c" /></svg>
  <img src="/chrome.png" style="height: 200px; border-radius: 10px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.15); border: 1px solid #e2e5ea;" />
</div>

---
layout: section
---

# Démo

<p class="dim" style="font-size: 1.2rem;">
Rien de mieux que de vous montrer.
</p>

---
class: flex flex-col items-center justify-center
---

<p class="huge glow" style="text-align: center;">
Démo <span class="teal">Spring Boot</span>
</p>

<p class="dim" style="margin-top: 1.5rem; font-size: 1.1rem; text-align: center;">
Java · Hotpatch · À la main puis avec Claude
</p>

<div style="margin-top: 1.5rem; display: flex; justify-content: center;">
  <video src="https://github.com/theodo-group/debug-that/releases/download/demo-assets-v1/demo-java.mp4" controls style="height: 280px; border-radius: 10px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.15);" />
</div>

---
class: flex flex-col items-center justify-center
---

<p class="huge glow" style="text-align: center;">
Démo <span class="accent">React Native</span>
</p>

<p class="dim" style="margin-top: 1.5rem; font-size: 1.1rem; text-align: center;">
iOS crash · C++ Yoga layout · LLDB natif
</p>

<p style="margin-top: 2rem; text-align: center; color: #b8bfc9; font-size: 1rem; max-width: 500px;">
Un vrai bug qu'on a eu, que j'aurais jamais su résoudre sans dbg
</p>

---
class: px-12
---

# Ce que Claude sait faire avec dbg

<div style="margin-top: 1.5rem;">

<p style="font-size: 1.1rem; color: #1d2939; margin-bottom: 2rem;">
Le truc cool, c'est que Claude sait pas juste debugger — il sait <span class="accent">debug le debugger</span> :
</p>

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">

<div style="padding: 1rem; background: #f5f3f1; border-radius: 8px;">
  <p class="teal" style="font-weight: 600; margin-bottom: 0.5rem;">Trouver le process</p>
  <p class="dim" style="font-size: 0.9rem;">pgrep, lsof, ports ouverts</p>
</div>

<div style="padding: 1rem; background: #f5f3f1; border-radius: 8px;">
  <p class="teal" style="font-weight: 600; margin-bottom: 0.5rem;">Ajouter les symbols</p>
  <p class="dim" style="font-size: 0.9rem;">dSYM, source maps, path mapping</p>
</div>

<div style="padding: 1rem; background: #f5f3f1; border-radius: 8px;">
  <p class="teal" style="font-weight: 600; margin-bottom: 0.5rem;">Résoudre les source maps</p>
  <p class="dim" style="font-size: 0.9rem;">TypeScript → JS généré → breakpoints</p>
</div>

<div style="padding: 1rem; background: #f5f3f1; border-radius: 8px;">
  <p class="teal" style="font-weight: 600; margin-bottom: 0.5rem;">Choisir le bon protocol</p>
  <p class="dim" style="font-size: 0.9rem;">CDP, JSC, DAP, LLDB, Java...</p>
</div>

</div>

<p style="margin-top: 2rem; color: #b8bfc9; font-size: 1rem;">
Tous les trucs qui rebutent les juniors à utiliser un debugger dans des conditions réelles.
</p>

</div>

---
layout: section
---

# Comment ça marche

---
class: px-12
---

# Architecture

<div style="margin-top: 2rem; display: flex; justify-content: center;">
<div class="mono" style="font-size: 1rem; line-height: 2.2; text-align: center;">

<span style="background: #f5f3f1; padding: 0.4rem 1.2rem; border-radius: 8px; border: 1px solid #e2e5ea;">Claude Code</span>

<p class="dim" style="font-size: 0.8rem;">↓ shell commands</p>

<span style="background: #f5f3f1; padding: 0.4rem 1.2rem; border-radius: 8px; border: 1px solid #e2e5ea;"><span class="accent">dbg</span> CLI</span>

<p class="dim" style="font-size: 0.8rem;">↓ unix socket IPC</p>

<span style="background: #f5f3f1; padding: 0.4rem 1.2rem; border-radius: 8px; border: 1px solid #e2e5ea;">Daemon</span>

<p class="dim" style="font-size: 0.8rem;">↓ protocol adapters</p>

<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 0.5rem;">
  <span style="background: #e8f7f0; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #d4edda; font-size: 0.85rem;"><span class="teal">CDP</span> WebSocket</span>
  <span style="background: #e8f7f0; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #d4edda; font-size: 0.85rem;"><span class="teal">DAP</span> stdio</span>
</div>

<p class="dim" style="font-size: 0.8rem; margin-top: 0.5rem;">↓</p>

<div style="display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap;">
  <span style="background: #ffffff; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #e2e5ea; font-size: 0.85rem;">Node.js</span>
  <span style="background: #ffffff; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #e2e5ea; font-size: 0.85rem;">Bun</span>
  <span style="background: #ffffff; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #e2e5ea; font-size: 0.85rem;">LLDB</span>
  <span style="background: #ffffff; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #e2e5ea; font-size: 0.85rem;">Java</span>
  <span style="background: #ffffff; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #e2e5ea; font-size: 0.85rem;">Python</span>
</div>

</div>
</div>

---
class: px-12
---

# Les protocols de debug

<div style="margin-top: 1.5rem;">

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">

<div>
  <p class="accent" style="font-weight: 600; font-size: 1.1rem; margin-bottom: 0.5rem;">Chrome DevTools Protocol</p>
  <p class="dim" style="font-size: 0.9rem; line-height: 1.6;">
    WebSocket JSON-RPC<br>
    Node.js (V8 Inspector)<br>
    Bun (JavaScriptCore / WebKit Inspector)
  </p>
</div>

<div>
  <p class="teal" style="font-weight: 600; font-size: 1.1rem; margin-bottom: 0.5rem;">Debug Adapter Protocol</p>
  <p class="dim" style="font-size: 0.9rem; line-height: 1.6;">
    stdin/stdout JSON messages<br>
    LLDB (C/C++/Rust/Swift)<br>
    Java Debug Server<br>
    Python (debugpy)
  </p>
</div>

</div>

<div style="margin-top: 2.5rem; padding: 1.5rem; background: #f5f3f1; border-radius: 8px;">
  <p style="font-size: 1.1rem; color: #1d2939; margin-bottom: 0.5rem;">
    En fait, c'est juste une <span class="accent">CLI</span> qui fait interface avec ces protocols.
  </p>
  <p class="dim" style="font-size: 0.95rem;">
    Pas de magie. Les mêmes capacités que votre IDE — mais accessible depuis le terminal.
  </p>
</div>

</div>

---
class: px-12
---

# SKILL.md

<div style="display: flex; justify-content: center; margin-top: 1.5rem;">
  <img src="/skill-md.png" style="height: 340px; border-radius: 10px; box-shadow: 0 8px 30px rgba(29, 41, 57, 0.15); border: 1px solid #e2e5ea;" />
</div>

---
class: flex flex-col items-center justify-center
---

<p class="huge glow" style="text-align: center;">
Open Source
</p>

<div style="margin-top: 2rem; text-align: center;">
  <p class="mono" style="font-size: 1.3rem; color: #ff512c;">
    github.com/theodo-group/debug-that
  </p>
</div>

<div style="margin-top: 2.5rem; display: flex; flex-direction: column; align-items: center; gap: 0.8rem;">

```bash
$ bun install --global debug-that
```

```bash
$ npx skills add theodo-group/debug-that
```

</div>

<p style="margin-top: 2rem; color: #8f99aa; font-size: 1rem;">
  Merci ! Des questions ?
</p>
