# Website links for the global stats

The edits to make in `../tsum-tsum-website` once
<https://tsum-stats.gapscripts.app> is live, that is once
[CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md) step 6 passes. Not before, or the
links lead nowhere. Nothing here has been changed in that repo yet.

Follow that repo's `CLAUDE.md`: before-and-after screenshots at phone and
desktop width, `npm run typecheck` and `npm run build`, then one commit. It
goes live through the Devkit's **Tsum Tsum website** card.

The global page already links to the website. Its top bar's **Website**
button goes to <https://tsumtsum.gapscripts.app>, and its **Contribute your
rounds →** pill to <https://tsumtsum.gapscripts.app/stats-site>
(`ui/src/components/GlobalNote.svelte`). Edit 2 is what that pill lands on.

## 1. A Global stats item in the navbar

`docusaurus.config.ts`, `themeConfig.navbar.items`: one line after *Starter
tool*.

```ts
        {to: '/starter', label: 'Starter tool', position: 'left'},
        {href: 'https://tsum-stats.gapscripts.app', label: 'Global stats', position: 'left'},
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
```

It is an `href`, not a `to`: the page is on another host, so Docusaurus treats
it as an external link, as it does Discord and GitHub.

The footer's *The script* column can link it too, after *Tsum Tsum Stats*:

```ts
            {label: 'Tsum Tsum Stats', to: '/stats-site'},
            {label: 'Global stats', href: 'https://tsum-stats.gapscripts.app'},
```

## 2. Contribute to the global stats, on /stats-site

The page's source is `src/pages/stats-site.tsx`. Three edits.

**a. A constant**, beside `statsRepo` at the top:

```tsx
const globalStats = 'https://tsum-stats.gapscripts.app';
```

**b. A new section**, after *Get started*: the last `<Patch tone="surface" …>`
before `</FeltPage>`. It has the same form as *What it needs* and *Get
started*:

```tsx
      <Patch id="contribute" tone="surface" radius="34px" inset={8} style={{padding: '30px 32px', maxWidth: 820, ['--thread' as string]: '#6c6890'}}>
        <h2 style={{fontSize: 30, marginBottom: 14}}>Contribute to the global stats</h2>
        <p style={{lineHeight: 1.7, fontSize: 17, marginTop: 0}}>
          The <a href={globalStats}>global stats</a> pool the rounds of every player who sends them in: coins per second
          for each Tsum by skill level, boost items and game, from far more rounds than one account plays. They are worked
          out again every hour.
        </p>
        <ol style={{lineHeight: 1.8, fontSize: 17, margin: 0, paddingLeft: 22}}>
          <li>In Tsum Tsum Stats, press <b>Contribute</b> in the top bar.</li>
          <li>Read what is sent, tick the box and press <b>Join</b>.</li>
          <li>Leave Tsum Tsum Stats running. It sends your new rounds about once an hour.</li>
        </ol>
        <p style={{lineHeight: 1.7, fontSize: 17, marginTop: 18}}>
          Each round's figures are sent, with its Tsum, game, skill level, boost items, script version and settings. Device
          names, your Tsum List and file names never are. Your rounds are kept under a contributor number with no name or
          account, and the number is not published. The page shows figures added up over rounds of the same day, Tsum and
          settings, so a Tsum only a few players send can show figures close to their own; the page marks it "few players".
          You can stop at any time, or unlink your rounds so they no longer carry your number. Rounds already sent stay in
          the figures.
        </p>
        <div style={{display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 18}}>
          <Patch as="a" href={globalStats} tone="marigold" className="fbtn">Open the global stats</Patch>
        </div>
      </Patch>
```

`id="contribute"` lets a link point at the section:
`https://tsumtsum.gapscripts.app/stats-site#contribute`.

**c. Two sentences** that are no longer true once players can contribute:

- In the page head: "Nothing to install, and your data stays on your
  computer." becomes "Nothing to install, and your data stays on your
  computer unless you choose to share it."
- At the end of the *Share a page* patch: "Nothing leaves your computer unless
  you do this." becomes "Nothing leaves your computer unless you do this, or
  join the global stats."
