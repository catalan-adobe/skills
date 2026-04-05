# migrate-header Skill

## Known Limitations

### Nav item extraction assumes list-based markup

`extractNavItems()` in `capture-helpers.js` determines hierarchy by counting `<ul>`/`<ol>` ancestors. Sites using non-list navigation patterns produce flat results (all level 1, no parent):

- CSS mega menus built with `<div>` grids (no `<ul>`)
- JS-rendered menus (items not in DOM at capture time)
- `<details>`/`<summary>` accordion navs
- Flat `<a>` lists inside `<div>` containers
- `data-*` attribute hierarchies (`data-depth="2"`)
- Shadow DOM web components (can't pierce shadow roots)

**Mitigated:** Visibility filtering (display:none, visibility:hidden, opacity:0, max-height:0+overflow:hidden, zero-size rect) now skips links hidden inside dropdown/mega-menu panels. This prevents mega-menu featured items from being flattened into primary nav.

**Remaining gap:** Hierarchy detection still relies on list-ancestor counting. Non-list navigation patterns produce flat results.
