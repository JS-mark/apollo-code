# DRY-RUN FIXTURE — NOT PUBLISHED; URLs and checksums are deterministic placeholders
class ApolloCode < Formula
  desc "Multi-provider terminal coding agent"
  homepage "https://github.com/JS-mark/apollo-code"
  version "0.1.0-rc.1"
  license "Apache-2.0"

  on_arm do
    url "https://example.invalid/apollo-code/releases/download/v0.1.0-rc.1/apollo-code-darwin-arm64.tar.gz"
    sha256 "1111111111111111111111111111111111111111111111111111111111111111"
    # Tier: None; L4 native evidence is not authorized
  end

  on_intel do
    url "https://example.invalid/apollo-code/releases/download/v0.1.0-rc.1/apollo-code-darwin-x64.tar.gz"
    sha256 "2222222222222222222222222222222222222222222222222222222222222222"
    # Tier: None; L4 native evidence is not authorized
  end

  def install
    bin.install "apollo"
  end
end
