# Permanent Brand Images — drop them HERE

Any image you put in **this folder** is baked into the app permanently. It ships
with every build and deploy, shows up in the Gallery as a locked reference image
(can't be deleted from the UI), and teaches the taste memory your on-brand look.

You never have to upload these again.

### How to add images
1. Copy your image files into this folder (`src/assets/brand/`).
2. Rebuild / redeploy. Done.

Supported: `.png .jpg .jpeg .webp .gif .avif`

### Optional: tag an image to one brand by its filename
- `misfit-anything.jpg` → shows up under **Misfit Ministries**
- `forge-anything.png`  → shows up under **Forge Mode**
- any other name        → shared by both brands

Example names:
```
misfit-mud-and-wire.jpg
misfit-cross-fire.png
forge-before-after.jpg
forge-device-mockup.png
logo.png            (shared)
```

That's the whole system. Filenames do the routing; the folder does the rest.
