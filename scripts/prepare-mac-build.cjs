const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.default = async function prepareMacBuild(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[prepare-mac-build] Clearing extended attributes from ${appPath}.`)
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' })
}
