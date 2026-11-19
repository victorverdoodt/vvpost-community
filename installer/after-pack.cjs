// Depois de montar o app e antes de gerar o instalador: tira do Electron o que o VVPost não usa.
// SwiftShader (Vulkan/WebGL por software) só serve para WebGL sem GPU; o app roda com composição
// por software (disableHardwareAcceleration em src/main/index.ts) e não usa WebGL. Com
// VVPOST_GPU=1 a aceleração por hardware continua funcionando; só o WebGL por software some.
// São ~7 MB a menos no app e ~1,8 MB a menos no instalador.
// No Windows, o dxcompiler.dll e o dxil.dll (compilador de shaders do DirectX 12) só servem ao
// WebGPU, que o app também não usa; o ANGLE (WebGL/composição por GPU) usa o d3dcompiler_47.dll,
// que fica.
const { rmSync } = require('node:fs')
const { join } = require('node:path')

const UNUSED = {
  linux: ['libvk_swiftshader.so', 'vk_swiftshader_icd.json', 'libvulkan.so.1'],
  win32: [
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    'dxcompiler.dll',
    'dxil.dll'
  ],
  // No macOS ficam dentro do Electron Framework, que é assinado como um todo: não mexer.
  darwin: []
}

exports.default = async function afterPack(context) {
  for (const name of UNUSED[context.electronPlatformName] ?? []) {
    rmSync(join(context.appOutDir, name), { force: true })
  }
}
