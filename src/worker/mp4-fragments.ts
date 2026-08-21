const MAX_BOX_BYTES = 64 * 1024 * 1024

export interface Mp4ParserOptions {
  onInit: (data: Buffer) => void
  onFragment: (data: Buffer) => void
  maxBoxBytes?: number
}

export class Mp4FragmentParser {
  onInit: (data: Buffer) => void
  onFragment: (data: Buffer) => void
  maxBoxBytes: number
  buffer: Buffer
  initBoxes: Buffer[]
  fragmentBoxes: Buffer[]
  ready: boolean

  constructor({ onInit, onFragment, maxBoxBytes = MAX_BOX_BYTES }: Mp4ParserOptions) {
    this.onInit = onInit
    this.onFragment = onFragment
    this.maxBoxBytes = maxBoxBytes
    this.buffer = Buffer.alloc(0)
    this.initBoxes = []
    this.fragmentBoxes = []
    this.ready = false
  }

  push(chunk: Uint8Array | Buffer): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt32BE(0)
      const type = this.buffer.toString('ascii', 4, 8)
      if (size === 1) throw new Error('64-bit MP4 boxes are not supported')
      if (size < 8 || size > this.maxBoxBytes) throw new Error(`invalid MP4 box size ${size}`)
      if (this.buffer.length < size) return
      const box = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)
      this.#box(type, box)
    }
  }

  end(): void {
    if (this.buffer.length !== 0) throw new Error('truncated MP4 stream')
  }

  #box(type: string, box: Buffer): void {
    if (!this.ready) {
      if (type !== 'ftyp' && type !== 'moov') throw new Error(`unexpected MP4 init box ${type}`)
      this.initBoxes.push(box)
      if (type === 'moov') {
        this.ready = true
        this.onInit(Buffer.concat(this.initBoxes))
        this.initBoxes = []
      }
      return
    }
    if (type === 'moof') {
      this.fragmentBoxes = [box]
      return
    }
    if (type === 'mdat' && this.fragmentBoxes.length) {
      this.fragmentBoxes.push(box)
      this.onFragment(Buffer.concat(this.fragmentBoxes))
      this.fragmentBoxes = []
      return
    }
    if (type !== 'free' && type !== 'sidx') throw new Error(`unexpected MP4 media box ${type}`)
  }
}
