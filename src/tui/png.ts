import { inflateSync } from 'node:zlib'

export interface RgbaImage {
  data: Uint8Array
  width: number
  height: number
}

function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft
  const a = Math.abs(p - left)
  const b = Math.abs(p - up)
  const c = Math.abs(p - upperLeft)
  return a <= b && a <= c ? left : b <= c ? up : upperLeft
}

/** Decode Chromium's noninterlaced 8-bit RGB/RGBA PNGs into a fresh RGBA buffer. */
export function decodePng(input: Uint8Array): RgbaImage {
  const png = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (png.length < 33 || png.length > 32 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('invalid PNG')
  }
  let width = 0
  let height = 0
  let channels = 0
  let ended = false
  const chunks: Buffer[] = []
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (offset + 12 + length > png.length) throw new Error('truncated PNG')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('invalid PNG header')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error('PNG dimensions exceed limit')
      if (data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unsupported PNG format')
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      ended = true
      break
    }
    offset += length + 12
  }
  if (!width || !channels || !chunks.length || !ended) throw new Error('incomplete PNG')
  const stride = width * channels
  const expectedSize = (stride + 1) * height
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedSize })
  if (raw.length !== expectedSize) throw new Error('invalid PNG pixel data')
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) throw new Error('unsupported PNG filter')
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x
      const left = x >= channels ? pixels[index - channels] : 0
      const up = y > 0 ? pixels[index - stride] : 0
      const upperLeft = y > 0 && x >= channels ? pixels[index - stride - channels] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft)
      pixels[index] = (raw[y * (stride + 1) + x + 1] + predictor) & 255
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
    data[j] = pixels[i]
    data[j + 1] = pixels[i + 1]
    data[j + 2] = pixels[i + 2]
    data[j + 3] = channels === 4 ? pixels[i + 3] : 255
  }
  return { data, width, height }
}
