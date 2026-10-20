# Deploying Cytolume to GitHub Pages

Live site: [muyuhuatang.github.io/Cytolume](https://muyuhuatang.github.io/Cytolume/) ·
Repository: [muyuhuatang/Cytolume](https://github.com/muyuhuatang/Cytolume)

Every push to `main` runs [`deploy-pages.yml`](../.github/workflows/deploy-pages.yml),
which rebuilds the demo data, verifies it, builds the site and publishes it.
Nothing is deployed by hand.

## Verified release

Application release `de0642a` passed its production build and deployment on
**2026-10-18 (UTC)**, and the project owner then confirmed the browser check below.
Later documentation-only commits do not change the verified application code.

| Check | Result |
| --- | --- |
| Build and deploy | `build` and `deploy` jobs succeeded |
| Cell data | 453,251 synthetic cells in 48 example categories; all four layouts regenerated from fixed seeds and passed six data checks |
| HRA snapshot | `2b2e5c57a67ba1c4b778`, 22 models; file sizes, SHA-256 hashes, references and dependencies verified |
| Local routing and download progress | 134 behaviour assertions passed under both `/` and `/Cytolume/`; progress accounting verified for repeated requests, fast switching, truncated downloads and retries |
| Font | Inter 4.1 and its license committed; SHA-256 verified |
| Live files | Page returns HTTP 200 with the Quick start guide and the local font URL; the service worker, font CSS and font file match the release byte for byte |
| Browser check | Passed the [manual checklist](#browser-check) |

This release added the collapsible, reopenable **Quick start** guide and shorter
**2D / 3D** and **Cell type** labels. The body card became **Anatomy / Demo mapping**,
separating the HRA reference anatomy from the illustrative cell-to-organ links. Model
downloads show real progress, with a reload option on failure. The font is served by
the site itself. The browser check is manual: CI does not run
`npm run test:hra:browser`.

### README preview (2026-10-18)

The README's animated preview was recorded from the live site in Google Chrome:
light theme, `umap3d`, 453,251 cells, the female reference body with the lung
highlighted, and Quick start collapsed.

| File | Details |
| --- | --- |
| [GIF](../media/01-hero-light-anatomy.gif) | 1120 × 718, 80 frames at 10 fps (8-second loop); anatomy verified visible in every frame |
| [Still image](../media/01-hero-light-anatomy.png) | 1280 × 820, the first captured frame at full resolution |
| [Capture metadata](../media/01-hero-light-anatomy.json) | Source URL, browser version, viewport, page script URL, selected organ and encoding results |

To refresh it, follow [Updating the README preview](#updating-the-readme-preview).

## Routine updates

Work in a clone of the repository:

```bash
git status --short
git diff
git add -- README.md doc          # or the source files you changed
git commit -m "Describe the change"
git push origin main
```

The push starts the deployment workflow. Open
[Actions](https://github.com/muyuhuatang/Cytolume/actions), check that the newest run
is for your commit, wait for `build` and `deploy` to succeed, then run the
[browser check](#browser-check).

## First-time setup for a new repository

The repository root holds `web/`, `doc/`, `media/`, `.github/`, `README.md` and the
other top-level files directly.

1. **Create the repository** at <https://github.com/new>. Keep the default branch name
   `main`, because the workflow listens to it.
2. **Clone it, add the project files and commit**, including `.github/`,
   `.gitattributes` and `.gitignore`. The 22 HRA models are committed with ordinary
   Git; the largest file is about 22 MiB, below GitHub's 100 MiB per-file limit
   ([GitHub docs](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)).
   If Git asks for an identity, set `user.name` and `user.email` for the repository;
   GitHub's no-reply address from your account settings keeps your email private.
3. **Enable Pages**: **Settings → Pages → Build and deployment → Source → GitHub
   Actions**. No Jekyll or template workflow is needed.
4. **Push** with `git push origin main`. **Actions → Deploy Cytolume to GitHub Pages**
   runs automatically, or start it with **Run workflow** on `main`. If the workflow
   ran before Pages was enabled, enable Pages and re-run the failed jobs.

The repository should contain:

```text
.github/workflows/deploy-pages.yml
.gitattributes
.gitignore
README.md
LICENSE
doc/
media/
web/
  package.json
  package-lock.json
  src/
  scripts/
  spine/export/
  spine/requirements.txt
  public/vendor/hra/snapshot.json
  public/vendor/hra/models/...
  public/vendor/inter/snapshot.json
  public/vendor/inter/InterVariable.woff2
  public/vendor/inter/inter.css
  public/vendor/inter/LICENSE.txt
  public/hra-scene-sw.js
```

The workflow then:

1. Installs the dependencies pinned by `package-lock.json` and `spine/requirements.txt`.
2. Generates the four layouts of 453,251 synthetic cells and runs six data checks.
3. Tests local HRA request routing, model download progress and progress accounting
   when switching scenes.
4. Verifies the HRA and Inter snapshots, type-checks, and builds the site.
5. Uploads and deploys `web/dist-app/`.

When every job is green, open the site from the **deploy** job link or
**Settings → Pages → Visit site**. Project sites live at
`https://<user>.github.io/<repository>/`. The workflow reads the base path from the
Pages configuration, so no user name is hard-coded
([Vite deployment guide](https://vite.dev/guide/static-deploy.html#github-pages)).

## Browser check

1. Open the [site](https://muyuhuatang.github.io/Cytolume/) and hard-refresh
   (**Ctrl + F5**).
2. The 3D cell map appears with **Quick start** on the right. **Start exploring**
   collapses it, and clicking its title reopens it. The collapsed state persists when
   the browser allows local storage.
3. The body card reads **Anatomy / Demo mapping**. On first load the model download
   shows progress, which disappears once the body is drawn.
4. Click a cell and switch **Female / Male** to check organ highlighting. Switch
   layouts and **2D / 3D**, then refresh and check again.

The default female skin and lung models total about 37.4 MiB, so first-load time
depends on the network; the cell map stays usable meanwhile. Progress counts
downloaded bytes; parsing and drawing follow. With a warm cache the indicator may only
flash. If a download fails, use **Reload page**. The site needs WebGL2 and must be
served over HTTP(S); opening the HTML file directly cannot run the service worker.

The demo data is generated from fixed seeds, and exported figures keep the synthetic
data label. The anatomy panel uses HRA reference models; its cell-to-organ links are
illustrative. Models, scene JSON, component code, font and licenses all come from
committed files, so the running site depends on no external HRA API or font CDN.
Installing build dependencies still needs the npm and PyPI registries.

## Updating the README preview

The recorder opens the live site in an isolated Google Chrome session, selects the
light theme and the lung demo mapping, waits for the models to finish downloading,
and records an eight-second slow rotation of the real rendering. Before encoding, it
checks every frame for the visible body. The full interface stays on screen with
Quick start collapsed.

It needs Google Chrome, the dev dependencies from `npm ci`, and Python with Pillow
(`python -m pip install Pillow==12.3.0`). From `web/`:

```bash
npm run capture:readme -- --headful
```

This writes `media/01-hero-light-anatomy.gif`, a PNG still and the JSON capture
metadata, and switches the README hero to the GIF only after the frames pass the
check. Raw frames stay in the ignored `web/screenshots/`. Pass `--repo <path>` to
write into a different checkout. Review the GIF before committing. Recording is a
manual maintenance step; deployments never launch Chrome.

## Local reproduction

The workflow uses Node 24.19.0 and Python 3.14.6. Python packages are pinned in
`web/spine/requirements.txt` and JavaScript packages in `web/package-lock.json`.

```bash
cd web
npm ci
python -m pip install -r spine/requirements.txt
python -m spine.export.build_all
npm run test:hra
BASE_PATH=/Cytolume/ npm run build:app   # use your repository name; '/' for a domain root
npm run preview:app
```

In PowerShell, set the base path with `$env:BASE_PATH = '/Cytolume/'` before
`npm run build:app`.

`npm run build:app` includes `hra:verify`, `font:verify` and the TypeScript check.
The HRA and font snapshots carry per-file SHA-256 hashes, so a missing or modified
file stops the build. The synthetic cell data is regenerated from fixed seeds and
pinned dependencies; byte-identical floating-point output or compression across
operating systems is not guaranteed. To archive the exact files of a deployment,
download the **Artifacts → github-pages** bundle from that Actions run before it
expires under the repository's retention policy.

## Netlify (optional)

[`netlify.toml`](../netlify.toml) mirrors the same steps for a git-connected Netlify
site: Node 24.19.0 and Python 3.14.6, `npm ci`, data generation and checks, the
anatomy tests, then `npm run build:app`, publishing `web/dist-app`.
