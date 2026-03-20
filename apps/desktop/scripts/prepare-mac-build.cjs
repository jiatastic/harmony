const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * Clear extended attributes before codesign. AppleDouble (._*) can break signing.
 *
 * Note: On macOS Sequoia+, paths under ~/Documents can carry com.apple.provenance
 * that makes `codesign --options runtime` fail. The desktop package.json mac builds
 * use directories.output under /var/tmp to avoid that; this hook still helps CI
 * and other layouts.
 */
exports.default = async function prepareMacBuild(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  if (!fs.existsSync(appPath)) {
    return
  }

  console.log(`[prepare-mac-build] Clearing extended attributes under ${context.appOutDir}.`)
  execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
}
