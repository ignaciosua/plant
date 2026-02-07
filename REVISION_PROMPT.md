# Revisión de Alineación Axial de Cilindros en Simulador 3D de Plantas

## Contexto del Proyecto
Simulador 3D de plantas procedurales usando Three.js. El tronco principal (depth === 0) está compuesto por múltiples segmentos cilíndricos apilados verticalmente.

## Requisitos de Alineación
Los cilindros del tronco principal deben cumplir:

1. **Alineación Axial Perfecta**: Todos los cilindros deben ser coaxiales, compartiendo el mismo eje vertical (eje Y)
2. **Sin Rotación Lateral**: Cada cilindro debe extenderse directamente hacia arriba sin ninguna rotación alrededor del eje Y
3. **Continuidad de Radios**: El radio de la base de cada cilindro nuevo debe coincidir exactamente con el radio del tope del cilindro anterior
4. **Sin Movimiento por Viento**: El tronco principal no debe tener animación de "sway" (balanceo por viento)

## Geometría Base
- `CylinderGeometry(0.78, 1, 1, 18, 1, false)` - taper factor: radio superior = 0.78 × radio inferior
- Geometría trasladada: `translate(0, 0.5, 0)` - el pivote está en la base del cilindro

## Cambios Implementados

### 1. Cálculo Progresivo de Radios (líneas ~380-420 en main.js)
```javascript
// Factor de taper de la geometría
const GEOMETRY_TAPER = 0.78;
let currentRadius = radius;

// En cada iteración:
const segmentRadius = Math.max(0.011, currentRadius);
currentRadius = segmentRadius * GEOMETRY_TAPER; // Radio para el siguiente segmento
```

### 2. Inicialización del Pivote (líneas ~589-607 en main.js)
```javascript
pivot.position.copy(start);
const directionNormalized = direction.clone().normalize();
const dotProduct = directionNormalized.dot(UP);

if (Math.abs(dotProduct) > 0.9999) {
  if (dotProduct < 0) {
    pivot.quaternion.setFromAxisAngle(AXIS_X, Math.PI);
  }
  // Si apunta hacia arriba, quaternion queda en identidad
} else {
  pivot.quaternion.setFromUnitVectors(UP, directionNormalized);
}
```

### 3. Actualización en el Loop de Animación (líneas ~695-725 en main.js)
```javascript
// Forzar rotación identidad para tronco principal
if (segment.depth === 0) {
  segment.pivot.quaternion.set(0, 0, 0, 1);
} else if (segment.parentSegment) {
  // Interpolación para ramas
}

// Solo aplicar sway a ramas, no al tronco
if (segment.depth !== 0) {
  const swayAmount = ...;
  segment.pivot.quaternion.multiply(swayQuatA).multiply(swayQuatB);
}
```

## Tareas de Revisión

Por favor verifica:

1. **Alineación Visual**: ¿Los cilindros del tronco están perfectamente alineados verticalmente sin desviaciones laterales?

2. **Continuidad de Radios**: ¿La transición entre cilindros es suave sin gaps o solapamientos visibles?

3. **Cálculo Matemático**: ¿El radio de cada nuevo segmento se calcula correctamente usando el factor GEOMETRY_TAPER (0.78)?

4. **Rotaciones**: ¿Los segmentos con depth === 0 mantienen rotación identidad (0,0,0,1) en todo momento?

5. **Posicionamiento**: ¿La posición del siguiente segmento es correcta considerando que:
   - Cada cilindro tiene su pivote en y=0 (base)
   - La geometría está trasladada 0.5 unidades hacia arriba
   - El tipPosition debe calcularse desde el pivote + altura completa del cilindro

6. **Posibles Problemas**:
   - ¿Hay alguna rotación residual que cause desalineación?
   - ¿El cálculo de tipPosition es correcto para posicionar el siguiente segmento?
   - ¿La escala radial afecta la alineación?

## Archivos Relevantes
- `/home/neo/ainanana/plants/main.js` (líneas 280-750)
- `/home/neo/ainanana/plants/index.html` (tiene importmap para Three.js)

## Resultado Esperado
Un tronco principal perfectamente recto y alineado donde cada cilindro se apila sin rotación lateral, manteniendo continuidad visual en los radios.
