'use strict';

/* Homepage: cena Three.js de fundo (campo de partículas em esfera + malha
   central girando) e animação de entrada com GSAP. Degrada com elegância se o
   WebGL não estiver disponível ou o usuário preferir menos movimento. */

(function () {
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── GSAP: entrada do hero ─────────────────────────── */
  function animateIn() {
    if (prefersReduced || typeof gsap === 'undefined') {
      document.querySelectorAll('.reveal').forEach((el) => { el.style.opacity = 1; });
      return;
    }
    // fromTo: o estado final é opacity 1 explícito (o CSS deixa .reveal em 0 pra
    // evitar flash antes do JS; um simples .from animaria 0→0 e ficaria invisível).
    const tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.9 } });
    tl.fromTo('#r-eyebrow', { y: 18, opacity: 0 }, { y: 0, opacity: 1 })
      .fromTo('#r-title', { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 1.0 }, '-=0.6')
      .fromTo('#r-lead', { y: 22, opacity: 0 }, { y: 0, opacity: 1 }, '-=0.65')
      .fromTo('#r-actions', { y: 20, opacity: 0 }, { y: 0, opacity: 1 }, '-=0.6')
      .fromTo('#r-mhead', { y: 16, opacity: 0 }, { y: 0, opacity: 1 }, '-=0.5')
      .fromTo('[data-mc]', { y: 26, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.09, duration: 0.7 }, '-=0.45');
  }

  /* ── Three.js: fundo ───────────────────────────────── */
  function initThree() {
    if (prefersReduced || typeof THREE === 'undefined') return;
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) { return; } // sem WebGL: fica só o gradiente do CSS
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 16);

    const group = new THREE.Group();
    scene.add(group);

    // 1) Campo de partículas distribuído numa esfera (espiral de Fibonacci).
    const COUNT = window.innerWidth < 700 ? 1400 : 2600;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const R = 9.2;
    const cA = new THREE.Color(0x0f62fe); // azul IBM
    const cB = new THREE.Color(0x8a3ffc); // roxo
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < COUNT; i++) {
      const y = 1 - (i / (COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const jitter = 0.94 + Math.random() * 0.12;
      positions[i * 3] = Math.cos(theta) * r * R * jitter;
      positions[i * 3 + 1] = y * R * jitter;
      positions[i * 3 + 2] = Math.sin(theta) * r * R * jitter;
      const c = cA.clone().lerp(cB, (y + 1) / 2);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pMat = new THREE.PointsMaterial({
      size: 0.11, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const points = new THREE.Points(pGeo, pMat);
    group.add(points);

    // 2) Malha icosaédrica central (wireframe sutil).
    const icoGeo = new THREE.IcosahedronGeometry(4.4, 1);
    const wire = new THREE.WireframeGeometry(icoGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4589ff, transparent: true, opacity: 0.16 });
    const ico = new THREE.LineSegments(wire, lineMat);
    group.add(ico);

    // 3) Núcleo luminoso.
    const coreGeo = new THREE.IcosahedronGeometry(1.5, 0);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x78a9ff, transparent: true, opacity: 0.08, wireframe: true });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    group.rotation.z = 0.35;

    // Parallax pelo mouse.
    const target = { x: 0, y: 0 };
    window.addEventListener('mousemove', (e) => {
      target.x = (e.clientX / window.innerWidth - 0.5) * 0.6;
      target.y = (e.clientY / window.innerHeight - 0.5) * 0.6;
    });

    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    window.addEventListener('resize', resize);
    resize();

    let raf, t = 0, running = true;
    function tick() {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      t += 0.0016;
      group.rotation.y = t;
      ico.rotation.y = -t * 0.6;
      ico.rotation.x = t * 0.25;
      core.rotation.y = t * 1.2;
      // câmera segue o mouse suavemente
      camera.position.x += (target.x * 3 - camera.position.x) * 0.04;
      camera.position.y += (-target.y * 3 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }
    tick();

    // Pausa quando a aba não está visível (economia de bateria).
    document.addEventListener('visibilitychange', () => {
      running = !document.hidden;
      if (running) tick(); else cancelAnimationFrame(raf);
    });

    // Entrada da cena com GSAP (zoom sutil).
    if (typeof gsap !== 'undefined') {
      gsap.from(group.scale, { x: 0.6, y: 0.6, z: 0.6, duration: 2.2, ease: 'power2.out' });
      gsap.from(pMat, { opacity: 0, duration: 2.4, ease: 'power1.out' });
    }
  }

  function start() { animateIn(); initThree(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
