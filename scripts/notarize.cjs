const path = require('node:path')
const { notarize } = require('@electron/notarize')

exports.default = async function notarizeMacApp(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  if (process.env.SKIP_MAC_NOTARIZE === '1') {
    console.log('[notarize] Skipping notarization because SKIP_MAC_NOTARIZE=1.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appBundleId = context.packager.appInfo.id
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  const appleApiKey = process.env.APPLE_API_KEY
  const appleApiKeyId = process.env.APPLE_API_KEY_ID
  const appleApiIssuer = process.env.APPLE_API_ISSUER

  if (appleApiKey && appleApiKeyId && appleApiIssuer) {
    console.log('[notarize] Using App Store Connect API key credentials.')

    await notarize({
      tool: 'notarytool',
      appBundleId,
      appPath,
      appleApiKey,
      appleApiKeyId,
      appleApiIssuer
    })

    return
  }

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  if (appleId && appleIdPassword && teamId) {
    console.log('[notarize] Using Apple ID credentials.')

    await notarize({
      tool: 'notarytool',
      appBundleId,
      appPath,
      appleId,
      appleIdPassword,
      teamId
    })

    return
  }

  console.warn(
    '[notarize] Skipping macOS notarization because credentials are missing. ' +
      'Set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER, or APPLE_ID, ' +
      'APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.'
  )
}
