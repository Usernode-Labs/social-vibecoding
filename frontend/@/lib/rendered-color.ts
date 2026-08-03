export function renderedAlpha(color: string) {
  const context = document.createElement("canvas").getContext("2d")
  if (!context) throw new Error("Rendered colour checks require a 2D canvas context")
  context.canvas.width = 1
  context.canvas.height = 1
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  return context.getImageData(0, 0, 1, 1).data[3] / 255
}
