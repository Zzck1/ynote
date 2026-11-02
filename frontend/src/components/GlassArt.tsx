import { useEffect, useRef } from 'react'
import * as THREE from 'three'

const vertex = `precision highp float;
in vec3 position; in vec2 uv; out vec2 vUv;
void main(){ vUv=uv; gl_Position=vec4(position,1.); }`
const background = `precision highp float;
in vec2 vUv; out vec4 fragColor;
void main(){
 vec2 p=(vUv-.5)*vec2(.5625,1.);
 vec3 c=mix(vec3(.95,.98,1.),vec3(.75,.86,1.),smoothstep(-.3,.3,p.y));
 float wave=sin(p.y*13.+p.x*7.)*.055;
 c=mix(c,vec3(.22,.55,.96),exp(-pow((p.x-wave+.08)*13.,2.))*.65);
 c=mix(c,vec3(.89,.93,1.),smoothstep(.1,.35,length(p)));
 fragColor=vec4(c,1.);
}`
const glass = `precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D paintComposeRT; uniform float uTime;
const float aspect=.5625; const float IOR=1.46; const float thickness=.052;
const float bevel=.064*.82; const float PI=3.14159265359;
float sdf(vec2 p){ vec2 q=abs(p)-vec2(.213,.187)+.065;
 return min(max(q.x,q.y),0.)+length(max(q,0.))-.065; }
float quintic(float t){return t*t*t*(t*(t*6.-15.)+10.);}
float heightField(vec2 p){return thickness*quintic(clamp(max(-sdf(p),0.)/bevel,0.,1.));}
vec3 normalAt(vec2 p){float h=clamp(.064*.13,.003,.012);
 vec2 gradient=vec2(heightField(p+vec2(h,0.))-heightField(p-vec2(h,0.)),heightField(p+vec2(0.,h))-heightField(p-vec2(0.,h)))/(2.*h);
 return normalize(vec3(-gradient,1.)); }
vec2 traceRay(vec2 p, vec3 normal, float eta){
 float height=heightField(p); vec3 ray=refract(vec3(0.,0.,-1.),normal,1./eta);
 if(dot(ray,ray)<.001)ray=vec3(0.,0.,-1.);
 vec3 exitPoint=vec3(p,height)+ray*(height/max(-ray.z,.025));
 vec3 exitRay=refract(ray,vec3(0.,0.,1.),eta);
 if(dot(exitRay,exitRay)<.001)exitRay=vec3(0.,0.,-1.);
 vec2 hit=exitPoint.xy+exitRay.xy*(.14/max(-exitRay.z,.025));
 return hit/vec2(aspect,1.)+.5;
}
vec3 sampleRGB(vec2 r,vec2 g,vec2 b,float lod){return vec3(textureLod(paintComposeRT,clamp(r,.001,.999),lod).r,textureLod(paintComposeRT,clamp(g,.001,.999),lod).g,textureLod(paintComposeRT,clamp(b,.001,.999),lod).b);}
float ggx(vec3 n,vec3 l){
 vec3 v=vec3(0.,0.,1.); vec3 h=normalize(l+v);
 float NoH=max(dot(n,h),0.);float NoV=max(dot(n,v),.001);float NoL=max(dot(n,l),.001);float VoH=max(dot(v,h),0.);
 float a=.32*.32;float a2=a*a;float d=a2/(PI*pow(NoH*NoH*(a2-1.)+1.,2.));
 float vis=.5/(NoL*sqrt(NoV*NoV*(1.-a2)+a2)+NoV*sqrt(NoL*NoL*(1.-a2)+a2));
 float f0=pow((IOR-1.)/(IOR+1.),2.);float f=f0+(1.-f0)*pow(1.-VoH,5.);
 return d*vis*f*NoL;
}
void main(){
 vec2 p=(vUv-.5)*vec2(aspect,1.); float d=sdf(p);float aa=fwidth(d);
 float mask=1.-smoothstep(-aa,aa,d);vec3 n=normalAt(p);
 vec2 r=traceRay(p,n,IOR-.018),g=traceRay(p,n,IOR),b=traceRay(p,n,IOR+.018);
 vec2 rim=length(n.xy)>.0001?normalize(n.xy):vec2(0.);
 float path=heightField(p)/max(abs(refract(vec3(0.,0.,-1.),n,1./IOR).z),.025);
 vec2 displacement=rim*path*.16/vec2(aspect,1.);
 vec2 faceUV=mix(.5+(vUv-.5)*.975,g,.12);
 float interior=max(-d,0.);float faceWeight=smoothstep(bevel*.5,bevel,interior);
 float outerWeight=(1.-smoothstep(0.,bevel*.28,interior))*.4;
 float innerWeight=max(0.,1.-faceWeight-outerWeight);
 vec3 color=textureLod(paintComposeRT,faceUV,4.).rgb*faceWeight;
 color+=sampleRGB(r-displacement,g-displacement,b-displacement,1.)*innerWeight;
 vec2 outerUV=vUv+displacement*1.28;
 color+=sampleRGB(outerUV+(r-g)*.6,outerUV,outerUV+(b-g)*.6,4.8)*outerWeight;
 color/=(faceWeight+innerWeight+outerWeight);
 color=mix(color,vec3(1.),.13);
 float outerBevelSupport=(1.-smoothstep(bevel*.18,bevel*.6,interior))*mask;
 vec3 light=vec3(0.);for(int i=0;i<4;i++){
  float angle=float(i)*PI*.5+uTime*.07;
  vec3 l=normalize(vec3(cos(angle)*.94,sin(angle)*.94,.35));
  light+=ggx(n,l)*mix(vec3(.88,.94,1.),vec3(1.,.95,.88),float(i%2));
 }
 color+=light*outerBevelSupport*1.4;
 float shadow=exp(-max(d,0.)*90.)*.06*(1.-mask);
 fragColor=vec4(mix(vec3(.28,.49,.76),color,mask),mask*.88+shadow);
}`

/** Fixed portrait artwork: background render target → glass → crisp DOM content. */
export function GlassArt() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvas.current) return
    let renderer: THREE.WebGLRenderer | undefined, target: THREE.WebGLRenderTarget | undefined
    let geometry: THREE.PlaneGeometry | undefined, bg: THREE.RawShaderMaterial | undefined
    let material: THREE.RawShaderMaterial | undefined, observer: IntersectionObserver | undefined
    let frame = 0
    try {
      const context = canvas.current.getContext('webgl2', { alpha: true, antialias: true })
      if (!context) return
      renderer = new THREE.WebGLRenderer({ canvas: canvas.current, context, alpha: true, antialias: true })
      renderer.setSize(1080, 1920, false); renderer.setClearColor(0x000000, 0)
      target = new THREE.WebGLRenderTarget(1080, 1920, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false })
      geometry = new THREE.PlaneGeometry(2, 2)
      bg = new THREE.RawShaderMaterial({ vertexShader: vertex, fragmentShader: background, glslVersion: THREE.GLSL3, depthTest: false })
      material = new THREE.RawShaderMaterial({ vertexShader: vertex, fragmentShader: glass, glslVersion: THREE.GLSL3, transparent: true, depthTest: false, uniforms: { paintComposeRT: { value: target.texture }, uTime: { value: 0 } } })
      const bgScene = new THREE.Scene(), glassScene = new THREE.Scene(), camera = new THREE.Camera()
      bgScene.add(new THREE.Mesh(geometry, bg)); glassScene.add(new THREE.Mesh(geometry, material))
      renderer.setRenderTarget(target); renderer.render(bgScene, camera); renderer.setRenderTarget(null)
      const reduce = matchMedia('(prefers-reduced-motion: reduce)')
      let visible = true, previous = 0
      const render = (time: number) => {
        if (visible && !document.hidden && (time - previous > 50 || reduce.matches)) {
          material!.uniforms.uTime.value = reduce.matches ? 0 : time / 1000
          renderer!.render(glassScene, camera); previous = time
        }
        if (!reduce.matches) frame = requestAnimationFrame(render)
      }
      observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; })
      observer.observe(canvas.current); render(100)
    } catch { /* DOM artwork is the fallback on devices without WebGL2. */ }
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); target?.dispose(); geometry?.dispose(); bg?.dispose(); material?.dispose(); renderer?.dispose(); }
  }, [])
  return <canvas ref={canvas} width="1080" height="1920" className="glass-canvas" aria-hidden="true" />
}
