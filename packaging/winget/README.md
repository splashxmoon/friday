# Friday on winget

`manifests/` holds Friday's manifests for [winget-pkgs](https://github.com/microsoft/winget-pkgs), laid out as they go there.

The first version goes in by hand, as a pull request to microsoft/winget-pkgs adding `manifests/f/FridayWork/Friday/<version>/`. After it's merged, the release workflow submits every new version itself (the `winget` job in `.github/workflows/release.yml`), once the repository has a `WINGET_TOKEN` secret: a classic personal access token with the `public_repo` scope, from an account with a fork of microsoft/winget-pkgs.
