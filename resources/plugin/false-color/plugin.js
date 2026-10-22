/*
 * False color by brightness. StarLight plugin. MIT license,
 * FM Digital Tools.
 *
 * The eye distinguishes a few dozen levels of gray, but many more colors.
 * By giving each level of light a different color, two areas that look
 * equally dark on screen take on different colors: the faint extensions of
 * a nebula, the residual gradients of the background and the exact shape
 * of a bright core become visible.
 *
 * The palettes are the ones designed by Nathaniel J. Smith and Stéfan van
 * der Walt (viridis with Eric Firing) in 2015: the perceived lightness
 * (in the CAM02-UCS color space) increases uniformly from the first to the
 * last color, so a step in brightness is worth the same step in color at
 * every point of the scale, and the order of the colors can be read even
 * in black and white or with reduced color vision. The authors released
 * them into the public domain (CC0):
 * https://github.com/BIDS/colormap. The 256 original entries are given here
 * (encoded sRGB), rounded to 12 bits per channel: at this precision the
 * luma really increases from one entry to the next, whereas at 8 bits a
 * few steps would drop by a thousandth.
 *
 * The method:
 *   1. the level t between 0 and 1 of each pixel is computed, in one of
 *      three ways:
 *      - “as on screen”: the luma (ITU-R BT.709 weights) of the image
 *        stretched as the viewer stretches it;
 *      - “linear”: the luminance of the linear data, mapped between a little
 *        below the sky background (median minus the noise, estimated from
 *        the median absolute deviation) and the value
 *        exceeded by only 0.05% of the pixels;
 *      - “logarithmic”: the same value x between 0 and 1, passed through
 *        log(1 + a·x) / log(1 + a). The function is increasing, is 0 at 0
 *        and 1 at 1, and devotes most of the scale to small values.
 *        The steepness a is chosen from the data: the sky background with its
 *        noise (up to twice the noise above the median) occupies the first
 *        fifth of the scale, and all the rest goes to the structures. With
 *        a fixed value, a deep exposure (noise small compared with the bright
 *        areas) and a short one would give very different results;
 *   2. the color is read from the palette, interpolating between the two
 *      nearest entries;
 *   3. with “stars in black and white” the stars are recognized with the
 *      “top-hat” transform of mathematical morphology (J. Serra, 1982):
 *      the difference between the image and its opening (a local minimum
 *      followed by a local maximum over a square larger than the stars)
 *      contains only the small, bright structures. Where the difference is
 *      clear, and in a two-pixel margin with a soft edge, the color
 *      gives way to the original
 *      gray, but only where the star is lighter than the palette color,
 *      so no dark ring forms around the core;
 *   4. the result is brought back to the linear data with the inverse
 *      stretch, so the viewer shows exactly the colors of the palette.
 */

const PALETTES = {
  magma:
    '00600203900900504b00d00906101200e07b01801409801f01a0b80270210d802f0280f903803011904203913a04d042' +
    '15a05904b17b06605519c07305f1bd08206a1df0910742010a207f2230b308b2450c50962680d60a128a0e80ad2ae0fa' +
    '0b72d110c0c22f511e0cc3191300d533e1430de3631560e63881690ee3ae17d0f53d31910fc3fa1a51024201ba107447' +
    '1cf10c46d1e51104941fb1144bc2121164e322911850a24111953125911955827211957e28b1185a42a51165ca2bf114' +
    '5ee2da1116122f510d63531010965632c1066763471026953630fe6b237f0fa6ce39b0f86e83b60f57003d20f47173ed' +
    '0f372c4090f37404240f475243f0f776345a0fa7734740fe78148f10378f4a910879b4c310f7a64dd1167b14f711d7bb' +
    '5111267c452a12e7cc5441377d455d1407db57614a7e15901547e75a915e7ed5c21687f25db1727f75f417c7fc60d186' +
    '80062619180463f19b8076581a580a6701b080d6891ba8106a21c48136bb1ce8156d41d98176ed1e38197061ed81a71f' +
    '1f781c73820081d75120a81e76a21481f78321e81f79c2278207b52318207cf23a8207e824382080124d82081b25681f' +
    '83425f81f84d26881e86727181d88127a81c89a28281a8b428b8198cd2948178e729d8159012a581391b2ae8109352b6' +
    '80e94f2bf80b9692c78089832cf80599d2d88019b72e07fd9d12e97fa9eb2f17f5a052f97f1a1f3017eca3a30a7e8a54' +
    '3127e2a6e31a7dda883237d8aa332b7d2abd3347ccad833c7c5af23457bfb0c34d7b8b273567b1b4135f7aab5b3677a2' +
    'b7637079ab90379792baa38378abc438c781bdf395778bf939f76fc133a9766c2d3b375cc463bd753c603c7748c7a3d2' +
    '73ec943dd734cad3e8729cc63f471ecdf3ff712cf840b707d114186fbd2a4256efd424326e3d5a43f6d7d7244d6cbd8a' +
    '45c6bfda146b6b2db947a6a5dcf48a699de649a68cdfc4ab67fe114bd673e274cf666e3b4e165ae504f564de64508641' +
    'e7751d635e8a53262ae9c54861feae55e614ebf575609ed058c5ffee05a45f6eef5bd5edefe5d65e5f0c5f05def1a60a' +
    '5d7f276255d1f336405ccf3f65c5c8f4a6785c5f556945c2f5f6b15c1f696ce5c0f726eb5c0f7b7095c1f837265c3f8b' +
    '7445c6f927625caf997805cffa079e5d4fa67bc5dbfac7db5e2fb17f95eafb68175f3fbb8365fcfc0854607fc4873612' +
    'fc989161dfcc8b0629fd08ce636fd38ec644fd790b652fda929661fdc948670fdf966680fe1984690fe49a26a1fe69c0' +
    '6b2fe89df6c4fe99fd6d6feba1b6e9feca396fcfeea5770ffefa75723ff0a93738ff1ab174cff2ace761ff2aec776ff3' +
    'b0a78cff3b287a2ff4b457b8ff4b637cfff4b817e6ff4b9e7fdff4bbc815ff4bd982cff4bf7845ff3c1585dff3c32876' +
    'ff2c4f88eff2c6d8a8ff1c8a8c1ff0ca88dbfefcc58f4feece390ffedd00929fecd1d944febd3b95efead58979fe9d75' +
    '995fe7d939b0fe6db09ccfe5dcd9e8fe3deba04fe2e08a21fe0e25a3dfdfe43a5afdde60a77fdce7da94fdae9aab1fd8' +
    'eb8acffd7ed5aedfd5ef2b0afd4f0fb28fd2f2db46fd1f4ab65fcff67b83fcef84ba1fcdfa1bc0fcbfbfbdefcafdcbfd',
  inferno:
    '00600203900900504c00e00906301300e07f01901309e01f0190c00270200e203002710403902e12604403614904f03e' +
    '16c05c04618f06a04f1b20790581d50890611f909a06a21d0ad0732420c007c2670d308528c0e708e2b20fb0962d7110' +
    '09e2fe1250a532413a0ac34b1500b13721660b639917d0bb3c01940be3e71ac0c040e1c50c24351de0c345b1f70c3481' +
    '2110c24a722c0c04cc2470bd4f02620ba51227e0b653429a0b25552b60ae5742d30aa5922ef0a55ae30c0a15c832809d' +
    '5e134409a5f836009860e37d0966233980956353b40956473d00966573eb09866640609a67442109e68143c0a268c457' +
    '0a86974720ad6a148c0b46aa4a70bb6b24c10c26ba4db0ca6c14f50d36c750f0db6cd5290e46d25430ed6d755d0f66db' +
    '5760ff6de5901096e25aa1126e55c311c6e75dd1256e95f612f6eb6101386ec62a1426ed64314b6ee65c1556ee67615e' +
    '6ee68f1686ee6a91716ed6c217b6ec6dc1846eb6f518d6e970f1976e77281a06e57421a96e375b1b26e07751bc6dd78e' +
    '1c56da7a81ce6d77c11d76d37db1e06cf7f41e96ca80e1f26c68271fb6c18412046bc85a20d6b68742166b088e21f6aa' +
    '8a72286a48c123169d8da23a6968f424368f90d24c68892725568094025e67895a26767097327166798c27a65e9a6284' +
    '6559bf28d64c9d92976429f22a0638a0b2aa62ea242b4623a3d2be618a562c860da6f2d2602a882dd5f6aa12e75ebaba' +
    '2f25dead32fd5d2aeb3085c5b043135b8b1c31f5abb3532a59eb4d336590b65342582b7d34e574b9535b566bad367557' +
    'bc5374548bdc381539bf338f52ac0b39c51bc223aa50bc393b84fbc4f3c74ebc663d54dbc7c3e44cbc923f44baca8403' +
    '4a9cbe413498cd4423487ce9434476cfe444465d13456453d28467442d3c479430d5048b41ed6449d40cd784b03fad8b' +
    '4c33e8d9e4d63d5db14e93c3dc44fd3b0dd651139ede852638bdfa53b378e0b550365e1d565352e2d57b33fe3e59132c' +
    'e4e5a7319e5e5be305e6e5d52f2e7d5ec2dee8c6032cbe9b61b2b7ea96332a3eb764b28fec566327ced267c267edf695' +
    '253eec6ae23fef86c822bf046e1216f106fb202f1b7151edf2672f1d8f3074a1c3f3b7651aef45780199f4e79b184f58' +
    '7b616ef607d1159f697ed144f7180912ef79825119f81841104f8885d0eff8f87a0daf958960c6f9b8b30b3fa18d00a0' +
    'fa78ed08ffac90a081fb0927075fb594506bfb9962065fbd980061fc099e061fc39bb063fc59d9069fc89f8072fcaa16' +
    '07ffcba3408ffcca530a3fcda710bbfcea900d4fceaae0effcdacd10bfcdaec129fccb0b148fcab2a167fc9b49188fc6' +
    'b681a9fc4b881ccfc1ba71effbebc6212fbabe6237fb6c0525cfb2c25282fadc442a9fa8c642d1fa3c832f9f9dca3323' +
    'f97cc334df91ce2378f8ad023a4f83d213d1f7cd41400f75d6042ff6dd80460f66d9f491f5edbe4c4f56ddd4f9f4edfc' +
    '52ff47e1a566f3fe3859ff39e565d9f32e73615f2de90653f28ead692f25ec86d2f23ee3713f24efe756f26f17799f2a' +
    'f2f7dcf30f47820f39f5e863f45f738a5f53f888e6f63f9c926f75fb0965f89fc39a2f9ffd59defb6fe7a18fcfff8a51',
  plasma:
    '0ce07a87210407488713506f89b16106b8ae18b0678c01b20648d21d70608e31fb05e8f321e05b903240059912261057' +
    '92028105592f2a005393d2bf05194a2dd04f9582fb04d96531804b97133504997e35104798a36e04699638a0449a23a6' +
    '0429ad3c103f9b83dd03d9c33f803b9ce4130399d842e0369e24480349ec4630329f647d02fa0049802ca094b202aa12' +
    '4cc027a1b4e6024a23500022a2b51a01fa3353301ca3b54d01aa42567017a49580014a5059a012a575b3010a5d5cd00d' +
    'a635e600ba685ff009a6d618007a72632006a7764b005a7b664004a7f67d003a82695002a856ae002a886c7003a8a6e0' +
    '003a8c6f8005a8e711006a8f729009a9074200ba9075a00fa90772013a8f78b017a8e7a301da8d7bb023a8b7d3029a89' +
    '7eb031a8680203aa8381a043a7f83104da7b849058a77860064a72878072a6c88f080a668a608fa608bd0a0a5a8d30b1' +
    'a528ea0c2a4b9000d3a439170e4a3b92d0f6a32943107a29959119a1f96f12aa1698513ca0b99a14ea019af1609f69c5' +
    '1719eb9da1839df9ef1959d3a031a79c7a181b99bba2c1cb9aea411dd9a1a551ef994a69201987a7d21397aa9022596c' +
    'aa423795eab724a950aca25c942add26e933af0280925b03292916b152a4908b282b68f9b3a2c98eab4c2db8dbb5e2ed' +
    '8ccb6f2ff8bdb813118aeb9332389fba4335890bb5348881bc635a872bd736c863be837e854bf8390844c093a2835c19' +
    '3b4826c293c6817c393d8808c493eb7f9c593fd7eac6940f7dbc784217ccc884337bec974457afca74577a0cb6469791' +
    'cc547b783cd448e774ce24a0766cf14b2757d004c4749d0e4d673ad1c4e872cd2b4fb71dd3950d70fd4751f701d55531' +
    '6f3d635446e5d705566d6d7e5686c8d8c57b6bad9958d6acda65a069edb45b2690dc15c5682dce5d7674ddb5ea667de7' +
    '5fc659df460f64be0162263de0d63562fe1a647621e2665a614e3266d606e3e6805f8e4a6935eae566a65dce616ba5cf' +
    'e6d6cd5c1e786e05b3e846f35a5e8f707598e9a71a58aea572e57ceb074256eeba755561ec5769553ecf77d545eda791' +
    '537ee47a5529eee7b951cef77cd50ef017e1500f0b7f64f2f1480a4e4f1d81f4d6f268344c9f2f8484bbf3885d4adf40' +
    '87249ff49887491f5189c483f598b1475f618c7467f688dc459f708f244cf7790743ef7e91d430f85933422f8c949414' +
    'f9295f406f989753f8f9e98b3eafa49a13dcfaa9b83cffaf9ce3c1fb59e53b3fba9fc3a5fbea13398fc3a2a38afc7a41' +
    '37cfcba5836ffcfa6f362fd2a87354fd6a9e347fd9ab633afdcace32dfdeae5320fe0afd313fe2b15306fe4b2e2fafe6' +
    'b462eefe7b5e2e1fe8b772d6fe8b8f2cafe9ba82bffe9bc12b4fe8bda2a9fe8bf329ffe7c0c295fe6c2528bfe4c3f282' +
    'fe2c5827afe0c72272fdec8b26bfdbca5264fd8cbf25efd4cd9258fd1cf3253fccd0d24ffc8d2824cfc3d42249fbed5d' +
    '248fb8d77247fb2d92247facdad247fa5dc8249f9ede324bf96dfe24ef8fe19251f86e34256f7ee4f25af75e6b25ff6c' +
    'e86264f62ea2268f58ebd26df4eed9270f44ef4272f39f10272f2ff2c26ff24f48268f1af63259f11f7e241f09f9921a',
  viridis:
    '44501454544c02755e45103c57645705258e45c0695a64610815be46609b5d546a0b55ec46e0ce6034720e76194760fe' +
    '62f47911664547c12d65a47e14367048115968448216f6994841856ad48519a6c14871b06d44871c56e74881da6fa488' +
    '1ef70c48820371e48721873048622d74148524175248425676248226a77248027e78147e29279147c2a779f4792bb7ae' +
    '4762cf7bc4722e37c946f2f77d646b30a7e346731e7ef4633327fb45e34680745935981245436d81c44f380827449393' +
    '8314443a783a43e3ba8434383cd84c4313e085542b3f385d42440686541e41986c41742c87341043e87a409451881401' +
    '4638873fa47688d3f34888933eb49a8983e44ac89d3dc4be8a23d44d08a73cc4e28ab3c44f48af3bd5058b33b55178b7' +
    '3ad5288bb3a55398be39d54b8c139555c8c438d56d8c738557e8ca37d58f8cc3755a08cf36e5b08d13665c18d335e5d1' +
    '8d53565e28d734f5f28d93476038db3406138dc3386238de3316338df3296438e13226538e231b6638e33146738e430d' +
    '6838e53066938e62ff6a28e72f86b28e82f16c28e92ea6d18e92e46e18ea2dd6f08eb2d77008eb2d070f8ec2ca71e8ec' +
    '2c372e8ed2bd73d8ed2b774c8ed2b075c8ed2aa76b8ed2a477a8ee29e7898ee2987988ee2927a88ed28c7b78ed2867c6' +
    '8ed2807d58ed27a7e48ec2747f38ec26e8028eb2688118eb2628208ea25c8308e925783f8e825184e8e724b85d8e6245' +
    '86c8e523f87b8e323a88a8e22348998e022f8a88df2298b78dd2248c68db21e8d58d92198e48d62148f38d420f9038d1' +
    '20a9128cf2069218cc2019308c91fd93f8c51fa94e8c21f695d8be1f396c8ba1f097b8b61ee98a8b21ec9998ae1ea9a8' +
    '8a91e99b88a41e99c789f1e99d689a1ea9e58941ec9f488f1eea038891f1a128821f5a2187c1faa308751ffa3f86e205' +
    'a4e86720da5d860215a6b85821ea7a850228a89848232a9883f23eaa783624bab582d258ac4824267ad381a276ae1811' +
    '286af0806297aff7fc2a9b0d7f12bcb1c7e62d0b2a7db2e4b387cf2f9b477c330fb557b7325b637aa33cb7179e354b7f' +
    '79036cb8d783385b9b77539fba97673b9bb77593d4bc474a3f0bd273b40cbdf72c428bed71c445bfa70c463c076fc481' +
    'c156eb49fc226da4bec2f6c94ddc3b6b84fdc486a651ec5569453ec6168155fc6e66e581c7a65b5a3c866485c5c93634' +
    '5e8c9e62060bcaa60c62ecb65f7652cc25e2676ccd5cd69bcd85b76c0ce45a16e5cef58b70acfa574730d0455d756d0f' +
    '54677dd1952f7a3d245177cad2e4ff7f2d384e7819d424ce841d4c4b5869d5549c891d5f4828bad684698e3d7144f90c' +
    'd7a434935d8241a95ed8b3ff988d933e49b2d9c3c99dcda43aea06dac393a30db4377a5bdbb35ba85dc3340ab0dca324' +
    'adadd1308b05dd82ecb30ddf2d1b5bde62b5b86dec29abb1df227fbdcdf9264c07dff24bc32e05231c5de0b219c88e11' +
    '202cb2e161ebcdde1c1d7d08e211c4d32e271b3d5ce2c1a4d87e32198db1e3718fddae3c189e04e41186e2de46187e56' +
    'e4b18ae7fe50192ea8e5519ced0e5b1aaef9e601bbf20e651cef48e6a1e4f6fe6f1fcf96e74215fbde79231fe3e7f24d'
}

const WEIGHTS = [0.2126, 0.7152, 0.0722]

/** Midtones function, the same as the viewer's. With m and 1 − m it is its own inverse. */
function mtf(x, m) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (m === 0.5) return x
  return ((m - 1) * x) / ((2 * m - 1) * x - m)
}

/** From a hexadecimal string (three digits per channel) to 256 RGB colors between 0 and 1, one after the other. */
function readPalette(hex) {
  const entries = new Float32Array(hex.length / 3)
  for (let i = 0; i < entries.length; i++) entries[i] = parseInt(hex.substr(3 * i, 3), 16) / 4095
  return entries
}

/** Smooth transition from 0 to 1 between a and b. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Minimum or maximum over a window of side 2r+1 along one direction, with
 * the van Herk and Gil-Werman algorithm: three comparisons per pixel,
 * whatever the radius.
 */
function extremum1D(src, dst, length, lines, lineStride, step, r, maximum) {
  const k = 2 * r + 1
  const m = length + 2 * r
  const left = new Float32Array(m)
  const right = new Float32Array(m)
  const row = new Float32Array(m)
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride
    for (let i = 0; i < m; i++) row[i] = src[base + Math.min(length - 1, Math.max(0, i - r)) * step]
    if (maximum) {
      for (let i = 0; i < m; i++) left[i] = i % k === 0 ? row[i] : Math.max(left[i - 1], row[i])
      for (let i = m - 1; i >= 0; i--) right[i] = i % k === k - 1 || i === m - 1 ? row[i] : Math.max(right[i + 1], row[i])
      for (let i = 0; i < length; i++) dst[base + i * step] = Math.max(right[i], left[i + 2 * r])
    } else {
      for (let i = 0; i < m; i++) left[i] = i % k === 0 ? row[i] : Math.min(left[i - 1], row[i])
      for (let i = m - 1; i >= 0; i--) right[i] = i % k === k - 1 || i === m - 1 ? row[i] : Math.min(right[i + 1], row[i])
      for (let i = 0; i < length; i++) dst[base + i * step] = Math.min(right[i], left[i + 2 * r])
    }
  }
}

/** Reduction by a factor f by averaging f × f blocks. */
function downsample(plane, w, h, f, wr, hr) {
  if (f === 1) return Float32Array.from(plane)
  const sum = new Float32Array(wr * hr)
  const count = new Float32Array(wr * hr)
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / f) * wr
    for (let x = 0; x < w; x++) {
      const j = row + Math.floor(x / f)
      sum[j] += plane[y * w + x]
      count[j]++
    }
  }
  for (let j = 0; j < sum.length; j++) sum[j] /= count[j]
  return sum
}

/** Maximum over the 3 × 3 square: grows a mask by one pixel, always along contiguous rows. */
function dilate1(m, w, h) {
  const t = new Float32Array(m.length)
  for (let y = 0; y < h; y++) {
    const b = y * w
    for (let x = 0; x < w; x++) {
      let v = m[b + x]
      if (x > 0 && m[b + x - 1] > v) v = m[b + x - 1]
      if (x < w - 1 && m[b + x + 1] > v) v = m[b + x + 1]
      t[b + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    const b = y * w
    const up = y > 0 ? b - w : b
    const down = y < h - 1 ? b + w : b
    for (let x = 0; x < w; x++) m[b + x] = Math.max(t[up + x], t[b + x], t[down + x])
  }
  return m
}

/**
 * Steepness of the logarithmic scale: the value a for which
 * log(1 + a·x0) / log(1 + a) equals 0.2, found by bisection on its
 * logarithm, between 10 and 100,000.
 */
function steepness(x0) {
  if (!(x0 > 0) || x0 >= 0.2) return 10
  let low = Math.log(10)
  let high = Math.log(1e5)
  for (let k = 0; k < 40; k++) {
    const mid = (low + high) / 2
    const a = Math.exp(mid)
    if (Math.log1p(a * x0) / Math.log1p(a) < 0.2) low = mid
    else high = mid
  }
  return Math.exp((low + high) / 2)
}

/** Mean over the 3 × 3 square, along contiguous rows: softens the edge of a mask. */
function blur1(m, w, h) {
  const t = new Float32Array(m.length)
  for (let y = 0; y < h; y++) {
    const b = y * w
    for (let x = 0; x < w; x++) {
      const s = m[b + Math.max(0, x - 1)] + m[b + x] + m[b + Math.min(w - 1, x + 1)]
      t[b + x] = s / 3
    }
  }
  for (let y = 0; y < h; y++) {
    const b = y * w
    const up = y > 0 ? b - w : b
    const down = y < h - 1 ? b + w : b
    for (let x = 0; x < w; x++) m[b + x] = (t[up + x] + t[b + x] + t[down + x]) / 3
  }
  return m
}

/** Values below which the fractions `fractions` of the values lie (estimated on a sample). */
function percentiles(values, fractions) {
  const step = Math.max(1, Math.floor(values.length / 300000))
  const sample = []
  for (let i = 0; i < values.length; i += step) sample.push(values[i])
  sample.sort((a, b) => a - b)
  return fractions.map((q) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))])
}

export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const n = width * height
  const { black, midtones, white } = context.stretch
  const range = Math.max(1e-6, white - black)
  const mInverse = 1 - midtones
  const stretch = (v) => mtf(Math.min(1, Math.max(0, (v - black) / range)), midtones)
  const unstretch = (y) => black + range * mtf(y, mInverse)
  const isColor = channels === 3

  // Luma as it appears on screen: used by the “as on screen” scale, by the
  // gray of the stars and by the search for them.
  const screen = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    screen[i] = isColor
      ? WEIGHTS[0] * stretch(data[i]) + WEIGHTS[1] * stretch(data[n + i]) + WEIGHTS[2] * stretch(data[2 * n + i])
      : stretch(data[i])
  }

  // 1. Level of each pixel.
  const level = new Float32Array(n)
  if (params.scale === 'screen') {
    level.set(screen)
  } else {
    for (let i = 0; i < n; i++) {
      level[i] = isColor ? WEIGHTS[0] * data[i] + WEIGHTS[1] * data[n + i] + WEIGHTS[2] * data[2 * n + i] : data[i]
    }
    const [median, high] = percentiles(level, [0.5, 0.9995])
    // Background noise from the median absolute deviation (σ ≈ 1.4826 MAD):
    // it depends on the pixels close to the median, that is on the
    // background, and not on the nebulae or the stars.
    const deviations = new Float32Array(Math.min(n, 300000))
    const step = Math.max(1, Math.floor(n / deviations.length))
    for (let k = 0; k < deviations.length; k++) deviations[k] = Math.abs(level[Math.min(n - 1, k * step)] - median)
    const sigma = 1.4826 * percentiles(deviations, [0.5])[0]
    const low = median - sigma
    const span = Math.max(1e-9, high - low)
    const logarithmic = params.scale === 'logarithmic'
    const a = logarithmic ? steepness((3 * sigma) / span) : 1
    const logNorm = 1 / Math.log1p(a)
    for (let i = 0; i < n; i++) {
      const x = Math.min(1, Math.max(0, (level[i] - low) / span))
      level[i] = logarithmic ? Math.log1p(a * x) * logNorm : x
    }
  }

  // 3. Star mask (optional).
  let stars = null
  if (params.grayStars) {
    // The square of the opening must contain the largest stars: it is
    // scaled to the image, from 3 to 24 pixels of radius.
    const r = Math.min(24, Math.max(3, Math.round(Math.min(width, height) / 250)))
    // The opening describes only the structures larger than the stars, so it
    // is smooth: it is computed on a copy reduced f times (mean of f × f
    // blocks) and brought back to full resolution by interpolation.
    // The top-hat stays at full resolution, with the exact outlines of the
    // stars. On 60 million pixels the computation drops from a few seconds
    // to a few hundred milliseconds.
    const f = Math.max(1, Math.floor(r / 4))
    const wr = Math.ceil(width / f)
    const hr = Math.ceil(height / f)
    const reduced = downsample(screen, width, height, f, wr, hr)
    const rr = Math.max(1, Math.ceil(r / f))
    const a = new Float32Array(wr * hr)
    extremum1D(reduced, a, wr, hr, wr, 1, rr, false)
    extremum1D(a, reduced, hr, wr, 1, wr, rr, false)
    extremum1D(reduced, a, wr, hr, wr, 1, rr, true)
    extremum1D(a, reduced, hr, wr, 1, wr, rr, true)
    // reduced is now the opening; the difference, through a smooth transition, is the mask.
    const mask = new Float32Array(n)
    for (let y = 0; y < height; y++) {
      const gy = Math.min(hr - 1, Math.max(0, (y + 0.5) / f - 0.5))
      const y0 = Math.floor(gy)
      const y1 = Math.min(hr - 1, y0 + 1)
      const fy = gy - y0
      for (let x = 0; x < width; x++) {
        const gx = Math.min(wr - 1, Math.max(0, (x + 0.5) / f - 0.5))
        const x0 = Math.floor(gx)
        const x1 = Math.min(wr - 1, x0 + 1)
        const fx = gx - x0
        const opening =
          (reduced[y0 * wr + x0] * (1 - fx) + reduced[y0 * wr + x1] * fx) * (1 - fy) +
          (reduced[y1 * wr + x0] * (1 - fx) + reduced[y1 * wr + x1] * fx) * fy
        const i = y * width + x
        mask[i] = smoothstep(0.04, 0.12, screen[i] - opening)
      }
    }
    // A two-pixel margin around each star and a soft edge, so as not to
    // leave around the gray core a ring with the colors of the wings.
    stars = blur1(dilate1(dilate1(mask, width, height), width, height), width, height)
  }

  // 2. and 4. Color from the palette, gray on the stars, back to the linear data.
  const entries = readPalette(PALETTES[params.palette] || PALETTES.viridis)
  const last = entries.length / 3 - 1
  const output = new Float32Array(3 * n)
  const rgb = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const p = level[i] * last
    const j = Math.min(last - 1, Math.floor(p))
    const f = p - j
    const s = stars ? stars[i] : 0
    let colorLuma = 0
    for (let c = 0; c < 3; c++) {
      rgb[c] = entries[3 * j + c] * (1 - f) + entries[3 * (j + 1) + c] * f
      colorLuma += WEIGHTS[c] * rgb[c]
    }
    // Gray takes the place of the color only where the star is lighter than
    // the palette color: on the edge of the mask, where the light of the
    // star has already dropped to the level of the background, the color
    // remains and no dark gray ring forms.
    const weight = s > 0 ? s * smoothstep(0, 0.08, screen[i] - colorLuma) : 0
    for (let c = 0; c < 3; c++) output[c * n + i] = unstretch(rgb[c] * (1 - weight) + screen[i] * weight)
  }
  return { width, height, channels: 3, data: output }
}
