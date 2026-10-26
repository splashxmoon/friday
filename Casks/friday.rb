cask "friday" do
  arch arm: "arm64", intel: "x64"

  version :latest
  sha256 :no_check

  url "https://github.com/splashxmoon/friday/releases/latest/download/Friday-#{arch}.dmg",
      verified: "github.com/splashxmoon/friday/"
  name "Friday"
  desc "Open-source harness for coding agents that work as a team"
  homepage "https://github.com/splashxmoon/friday"

  depends_on macos: :monterey

  app "Friday.app"

  zap trash: [
    "~/.friday",
    "~/Library/Application Support/friday-work",
    "~/Library/Logs/friday-work",
    "~/Library/Preferences/com.tryfridaywork.friday.local.plist",
    "~/Library/Saved Application State/com.tryfridaywork.friday.local.savedState",
  ]

  # Until the Mac builds are signed and notarized, macOS blocks the first open.
  # Remove this caveat when a signed release ships.
  caveats <<~EOS
    If macOS says Friday can't be opened or is damaged, run this once:
      xattr -dr com.apple.quarantine "#{appdir}/Friday.app"
  EOS
end
