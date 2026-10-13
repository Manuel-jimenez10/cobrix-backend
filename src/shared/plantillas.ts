import type { Plantilla } from './types.js';

export const plantillas: Plantilla[] = [
{
  tono: 'amable',
  nombre: 'Recordatorio amable',
  descripcion: 'Primer contacto. Cordial y asume que fue un olvido.',
  contenido:
  'Hola {{nombre}}, buen día. Te escribimos de {{empresa}} para recordarte que la factura {{folio}} por {{monto}} está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!'
},
{
  tono: 'firme',
  nombre: 'Seguimiento firme',
  descripcion: 'Segundo intento. Directo, menciona el atraso y pide una fecha.',
  contenido:
  '{{nombre}}, seguimos sin registrar el pago de la factura {{folio}} por {{monto}}, con {{dias}} días de atraso. Necesitamos acordar una fecha de pago esta semana para evitar recargos. Responde este mensaje y lo resolvemos.'
},
{
  tono: 'final',
  nombre: 'Aviso final',
  descripcion: 'Último intento antes de pasar el caso a jurídico.',
  contenido:
  '{{nombre}}, este es nuestro último aviso sobre la factura {{folio}} por {{monto}}. Si no recibimos respuesta en 48 horas, el adeudo se turnará a nuestro despacho jurídico. Aún podemos acordar un plan de pagos si nos escribes hoy.'
}];


export const ejemploVariables: Record<string, string> = {
  nombre: 'Jorge',
  empresa: 'Distribuidora del Valle',
  folio: 'F-1042',
  monto: '$28,500.00 MXN',
  dias: '67'
};