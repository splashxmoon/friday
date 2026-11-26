cask "friday" do
  arch arm: "arm64", intel: "x64"

  version :latest
  sha256 :no_check

  url "https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-#{arch}.dmg",
      verified: "github.com/splashxmoon/friday-code/"
  name "Friday"
  desc "One app for all your coding agents"
  homepage "https://github.com/splashxmoon/friday-code"

  depends_on macos: :monterey

  app "Friday.app"

  zap trash: [
    "~/.friday",
    "~/Library/Application Support/friday-work",
    "~/Library/Logs/friday-work",
    "~/Library/Preferences/com.tryfridaywork.friday.local.plist",
    "~/Library/Saved Application State/com.tryfridaywork.friday.local.savedState",
  ]
end
