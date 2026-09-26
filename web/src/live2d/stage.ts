import { CubismFramework, LogLevel, Option } from '@framework/live2dcubismframework';
import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismRenderer_WebGL } from '@framework/rendering/cubismrenderer_webgl';

/** Receives the parameter values computed each frame (see KurisuAnimator). */
export interface ParamSink {
  set(id: string, value: number): void;
}

export interface StageOptions {
  modelDir: string;
  mocFile: string;
  physicsFile: string;
  textureFile: string;
  /** Caps the device pixel ratio used for the backing store. */
  maxPixelRatio: number;
  /** 0 = uncapped (display refresh rate). */
  maxFps: number;
}

export interface Framing {
  /** Model height in view units (2.0 = whole model fits the view height). */
  height: number;
  /** Vertical position of the model center, in view units (+ = up). */
  centerY: number;
  /** Horizontal position of the model center, in view units. */
  centerX: number;
}

let frameworkStarted = false;

function startFramework(): void {
  if (frameworkStarted) return;
  const option = new Option();
  option.logFunction = (message: string) => console.debug('[Cubism]', message);
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
  frameworkStarted = true;
}

class KurisuModel extends CubismUserModel implements ParamSink {
  private ids = new Map<string, CubismIdHandle>();
  private texture: WebGLTexture | null = null;
  private image: HTMLImageElement | null = null;

  async load(opts: StageOptions): Promise<void> {
    const [moc, physics, image] = await Promise.all([
      fetchBuffer(opts.modelDir + opts.mocFile),
      fetchBuffer(opts.modelDir + opts.physicsFile),
      loadImage(opts.modelDir + opts.textureFile),
    ]);
    this.loadModel(moc, false);
    if (!this.getModel()) throw new Error('Invalid moc3 file');
    this.loadPhysics(physics, physics.byteLength);
    this.image = image;
  }

  attach(gl: WebGLRenderingContext, maskSize: number): void {
    this.createRenderer();
    const renderer = this.getRenderer();
    // Must precede startUp(): resizing the mask buffer recreates the clipping manager,
    // which only receives the GL context from startUp().
    renderer.setClippingMaskBufferSize(maskSize);
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);

    const tex = gl.createTexture();
    if (!tex || !this.image) throw new Error('Texture upload failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.texture = tex;
    renderer.bindTexture(0, tex);
  }

  detach(gl: WebGLRenderingContext | null): void {
    if (gl && this.texture && !gl.isContextLost()) gl.deleteTexture(this.texture);
    this.texture = null;
    this.deleteRenderer();
  }

  async swapTexture(gl: WebGLRenderingContext, url: string, maskSize: number): Promise<void> {
    const image = await loadImage(url);
    this.detach(gl);
    this.image = image;
    this.attach(gl, maskSize);
  }

  set(id: string, value: number): void {
    let handle = this.ids.get(id);
    if (!handle) {
      handle = CubismFramework.getIdManager().getId(id);
      this.ids.set(id, handle);
    }
    this.getModel().setParameterValueById(handle, value);
  }

  step(dt: number, apply: (sink: ParamSink) => void): void {
    apply(this);
    if (this._physics) this._physics.evaluate(this.getModel(), dt);
    this.getModel().update();
  }

  render(projection: CubismMatrix44, framing: Framing, viewport: number[]): void {
    const mm = this.getModelMatrix();
    mm.loadIdentity();
    mm.setHeight(framing.height);
    // Model vertices are already centred on the canvas origin.
    mm.translate(framing.centerX, framing.centerY);
    projection.multiplyByMatrix(mm);
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(null as unknown as WebGLFramebuffer, viewport);
    renderer.drawModel();
  }

  canvasAspect(): number {
    const m = this.getModel();
    return m.getCanvasWidth() / m.getCanvasHeight();
  }
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  return res.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Owns the WebGL canvas and the Kurisu model: render loop, resize, pixel ratio,
 * frame cap and WebGL context loss (frequent on Android when the app is backgrounded).
 */
export class Live2DStage {
  private gl: WebGLRenderingContext | null = null;
  private model = new KurisuModel();
  private raf = 0;
  private lastTime = 0;
  private accumulated = 0;
  private running = false;
  private ready = false;
  private lost = false;
  private fpsFrames = 0;
  private fpsTime = 0;

  fps = 0;
  framing: Framing = { height: 2, centerX: 0, centerY: 0 };
  onFrame: ((dt: number, sink: ParamSink) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, private opts: StageOptions) {}

  async init(): Promise<void> {
    startFramework();
    const attrs: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    };
    this.gl = (this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null;
    if (!this.gl) throw new Error('WebGL is not available');

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.model.detach(null);
      CubismRenderer_WebGL.doStaticRelease();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      if (this.gl && this.ready) this.model.attach(this.gl, this.maskSize());
    });

    await this.model.load(this.opts);
    this.model.attach(this.gl, this.maskSize());
    this.ready = true;
    this.resize();
  }

  get modelAspect(): number {
    return this.ready ? this.model.canvasAspect() : 1;
  }

  /** Largest texture the GPU accepts (phones: usually 4096 or more). */
  static maxTextureSize(): number {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const size = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return size;
    } catch {
      return 0;
    }
  }

  async setTexture(file: string): Promise<void> {
    if (file === this.opts.textureFile || !this.gl || !this.ready) return;
    this.opts.textureFile = file;
    await this.model.swapTexture(this.gl, this.opts.modelDir + file, this.maskSize());
  }

  setOptions(partial: Partial<Pick<StageOptions, 'maxFps' | 'maxPixelRatio'>>): void {
    Object.assign(this.opts, partial);
    this.resize();
  }

  private maskSize(): number {
    return this.opts.maxPixelRatio >= 2 ? 2048 : 1024;
  }

  resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      if (this.opts.maxFps > 0) {
        this.accumulated += dt;
        const step = 1 / this.opts.maxFps;
        if (this.accumulated < step * 0.95) return;
        this.frame(Math.min(this.accumulated, 0.1));
        this.accumulated = 0;
      } else {
        this.frame(dt);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame(dt: number): void {
    const gl = this.gl;
    if (!gl || !this.ready || this.lost) return;
    this.resize();

    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    this.model.step(dt, (sink) => this.onFrame?.(dt, sink));

    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const projection = new CubismMatrix44();
    // Keep square view units: y spans [-1, 1], x spans [-aspect, aspect].
    projection.scale(height / width, 1);
    this.model.render(projection, this.framing, [0, 0, width, height]);
  }
}
