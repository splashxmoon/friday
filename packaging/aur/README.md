# Friday on the AUR

`PKGBUILD` and `.SRCINFO` are the `friday-bin` package for the [Arch User Repository](https://aur.archlinux.org), laid out as they go there. It installs the release AppImage, unpacked into `/opt/friday`, with `friday` on the `PATH` and a desktop entry. The name ends in `-bin` because the AUR asks that of a package that installs a prebuilt app whose source is public.

The `friday` command turns off the app's own update check (`FRIDAY_NO_UPDATE_CHECK=1`): pacman updates it, and the check only works from the AppImage.

The first version goes in by hand, from an AUR account with an SSH key: clone `ssh://aur@aur.archlinux.org/friday-bin.git`, add a `# Maintainer:` line to the top of the `PKGBUILD`, copy both files in, commit and push.

For each new release, in this folder: set `pkgver` (and `pkgrel=1`), then

```bash
updpkgsums
makepkg --printsrcinfo > .SRCINFO
makepkg -si
```

and push both files to the AUR repository.
