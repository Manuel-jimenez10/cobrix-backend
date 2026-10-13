/** Datos de demostración (copiados del mock del frontend). Las fechas son relativas al momento de carga: seed.ts las desplaza a "ahora". */
import type {
  Cliente,
  Escalamiento,
  EventoAgente,
  Factura,
  Mensaje,
  Prioridad,
  PromesaPago,
  PuntoSerie } from
'../shared/types.js';

const HORA = 3_600_000;
const DIA = 24 * HORA;
const hace = (dias: number, horas = 0, minutos = 0) =>
new Date(Date.now() - dias * DIA - horas * HORA - minutos * 60_000).toISOString();
const en = (dias: number) => new Date(Date.now() + dias * DIA).toISOString();

export const empresaUsuario = { nombre: 'Distribuidora del Valle', administrador: 'Andrea' };

export const clientes: Cliente[] = [
{ id: 'c01', nombre: 'Jorge López Medina', empresa: 'Ferretería López', telefono: '+52 33 1847 2210', email: 'jorge@ferreterialopez.mx', canal: 'whatsapp' },
{ id: 'c02', nombre: 'Ramón Hernández Ruiz', empresa: 'Taller Mecánico Hernández', telefono: '+52 81 2290 4417', email: 'contacto@tallerhernandez.mx', canal: 'whatsapp' },
{ id: 'c03', nombre: 'María Guadalupe Ruiz', empresa: 'Abarrotes Doña Mary', telefono: '+52 55 6612 0934', email: 'donamary.abarrotes@gmail.com', canal: 'whatsapp' },
{ id: 'c04', nombre: 'Alejandra Torres Vega', empresa: 'Papelería Torres', telefono: '+52 222 418 7765', email: 'ventas@papeleriatorres.mx', canal: 'simulador' },
{ id: 'c05', nombre: 'Luis Fernando Castillo', empresa: 'Refaccionaria Castillo', telefono: '+52 442 310 5582', email: 'lf.castillo@refaccionariacastillo.mx', canal: 'whatsapp' },
{ id: 'c06', nombre: 'Patricia Mendoza Lara', empresa: 'Estética Paty', telefono: '+52 33 3021 8846', email: 'esteticapaty@hotmail.com', canal: 'simulador' },
{ id: 'c07', nombre: 'Héctor Ramírez Soto', empresa: 'Construcciones Ramírez', telefono: '+52 81 8355 1290', email: 'hramirez@construccionesramirez.mx', canal: 'whatsapp' },
{ id: 'c08', nombre: 'Sofía Vargas Peña', empresa: 'Panadería La Espiga', telefono: '+52 477 192 6603', email: 'pedidos@laespiga.mx', canal: 'whatsapp' },
{ id: 'c09', nombre: 'Ricardo Gómez Treviño', empresa: 'Transportes Gómez', telefono: '+52 81 1734 9921', email: 'rgomez@transportesgomez.mx', canal: 'whatsapp' },
{ id: 'c10', nombre: 'Daniela Ortiz Campos', empresa: 'Florería Ortiz', telefono: '+52 55 4418 3307', email: 'hola@floreriaortiz.mx', canal: 'simulador' },
{ id: 'c11', nombre: 'Arturo Navarro Gil', empresa: 'Carnicería Navarro', telefono: '+52 614 285 4410', email: 'carniceria.navarro@gmail.com', canal: 'whatsapp' },
{ id: 'c12', nombre: 'Verónica Salinas Ríos', empresa: 'Farmacia San Rafael', telefono: '+52 55 2093 7781', email: 'compras@farmaciasanrafael.mx', canal: 'whatsapp' },
{ id: 'c13', nombre: 'Eduardo Morales Fuentes', empresa: 'Imprenta Morales', telefono: '+52 33 1290 5548', email: 'eduardo@imprentamorales.mx', canal: 'simulador' },
{ id: 'c14', nombre: 'Gabriela Cruz Domínguez', empresa: 'Consultorio Dental Cruz', telefono: '+52 999 341 2276', email: 'recepcion@dentalcruz.mx', canal: 'whatsapp' },
{ id: 'c15', nombre: 'Fernando Aguilar Ibarra', empresa: 'Llantera Aguilar', telefono: '+52 664 503 8812', email: 'llanteraaguilar@outlook.com', canal: 'whatsapp' }];


export const facturas: Factura[] = [
{ id: 'f01', clienteId: 'c01', folio: 'F-1042', monto: 28500, fechaEmision: hace(97), fechaVencimiento: hace(67), estado: 'vencida', diasAtraso: 67 },
{ id: 'f02', clienteId: 'c01', folio: 'F-1088', monto: 20250, fechaEmision: hace(67), fechaVencimiento: hace(37), estado: 'vencida', diasAtraso: 37 },
{ id: 'f03', clienteId: 'c02', folio: 'F-0981', monto: 85000, fechaEmision: hace(142), fechaVencimiento: hace(112), estado: 'vencida', diasAtraso: 112 },
{ id: 'f04', clienteId: 'c03', folio: 'F-1120', monto: 6480, fechaEmision: hace(48), fechaVencimiento: hace(18), estado: 'promesa', diasAtraso: 18 },
{ id: 'f05', clienteId: 'c04', folio: 'F-1097', monto: 12500, fechaEmision: hace(64), fechaVencimiento: hace(34), estado: 'vencida', diasAtraso: 34 },
{ id: 'f06', clienteId: 'c04', folio: 'F-1015', monto: 8200, fechaEmision: hace(110), fechaVencimiento: hace(80), estado: 'pagada', diasAtraso: 0 },
{ id: 'f07', clienteId: 'c05', folio: 'F-1003', monto: 31200, fechaEmision: hace(125), fechaVencimiento: hace(95), estado: 'vencida', diasAtraso: 95 },
{ id: 'f08', clienteId: 'c06', folio: 'F-1151', monto: 3250, fechaEmision: hace(27), fechaVencimiento: en(3), estado: 'pendiente', diasAtraso: 0 },
{ id: 'f09', clienteId: 'c07', folio: 'F-0955', monto: 47400, fechaEmision: hace(150), fechaVencimiento: hace(120), estado: 'vencida', diasAtraso: 120 },
{ id: 'f10', clienteId: 'c07', folio: 'F-0990', monto: 25000, fechaEmision: hace(120), fechaVencimiento: hace(90), estado: 'vencida', diasAtraso: 90 },
{ id: 'f11', clienteId: 'c08', folio: 'F-1138', monto: 9860, fechaEmision: hace(38), fechaVencimiento: hace(8), estado: 'promesa', diasAtraso: 8 },
{ id: 'f12', clienteId: 'c09', folio: 'F-1061', monto: 54300, fechaEmision: hace(76), fechaVencimiento: hace(46), estado: 'vencida', diasAtraso: 46 },
{ id: 'f13', clienteId: 'c10', folio: 'F-1160', monto: 4120, fechaEmision: hace(18), fechaVencimiento: en(12), estado: 'pendiente', diasAtraso: 0 },
{ id: 'f14', clienteId: 'c11', folio: 'F-1109', monto: 18900, fechaEmision: hace(57), fechaVencimiento: hace(27), estado: 'promesa', diasAtraso: 27 },
{ id: 'f15', clienteId: 'c12', folio: 'F-1030', monto: 26750, fechaEmision: hace(104), fechaVencimiento: hace(74), estado: 'vencida', diasAtraso: 74 },
{ id: 'f16', clienteId: 'c13', folio: 'F-1072', monto: 15600, fechaEmision: hace(82), fechaVencimiento: hace(52), estado: 'vencida', diasAtraso: 52 },
{ id: 'f17', clienteId: 'c14', folio: 'F-1145', monto: 7900, fechaEmision: hace(33), fechaVencimiento: hace(3), estado: 'vencida', diasAtraso: 3 },
{ id: 'f18', clienteId: 'c15', folio: 'F-1080', monto: 39800, fechaEmision: hace(71), fechaVencimiento: hace(41), estado: 'promesa', diasAtraso: 41 }];


export const prioridades: Prioridad[] = [
{ clienteId: 'c02', score: 96, nivel: 'alta', razon: '112 días de atraso y el saldo más alto de la cartera ($85,000). Tres mensajes sin respuesta: el riesgo de que se vuelva incobrable crece cada semana.' },
{ clienteId: 'c07', score: 93, nivel: 'alta', razon: 'Dos facturas vencidas, la más antigua con 120 días. Respondió una vez hace un mes prometiendo pagar al cobrar una obra y después dejó de contestar.' },
{ clienteId: 'c09', score: 84, nivel: 'alta', razon: '$54,300 con 46 días de atraso. Pagó puntual todo el año pasado: parece un problema de flujo temporal, con alta probabilidad de recuperar si se contacta pronto.' },
{ clienteId: 'c01', score: 81, nivel: 'alta', razon: 'Dos facturas acumuladas ($48,750). Reconoció la deuda ayer y pidió opciones de pago: es el mejor momento para cerrar un plan.' },
{ clienteId: 'c05', score: 78, nivel: 'alta', razon: '95 días de atraso, pero disputa el cargo por una refacción defectuosa. Escalado a humano: no conviene enviar mensajes automáticos hasta resolverlo.' },
{ clienteId: 'c12', score: 66, nivel: 'media', razon: '74 días de atraso, aunque responde rápido y pidió copia de la factura. Probablemente es un tema administrativo, no de liquidez.' },
{ clienteId: 'c13', score: 58, nivel: 'media', razon: '52 días de atraso con monto moderado. Se envió el primer recordatorio ayer y aún no responde.' },
{ clienteId: 'c15', score: 52, nivel: 'media', razon: 'Prometió pagar el total esta semana. Monto relevante ($39,800): vale la pena vigilar que cumpla.' },
{ clienteId: 'c04', score: 47, nivel: 'media', razon: '34 días de atraso, pero pagó puntual la factura anterior. Un recordatorio amable suele bastar.' },
{ clienteId: 'c11', score: 41, nivel: 'media', razon: 'Promesa activa para dentro de 4 días. Cliente frecuente con buen historial de pago.' },
{ clienteId: 'c08', score: 38, nivel: 'baja', razon: 'Monto bajo ($9,860), pero su promesa de pago venció ayer. Conviene un recordatorio amable hoy.' },
{ clienteId: 'c14', score: 30, nivel: 'baja', razon: 'Solo 3 días de atraso y es cliente nuevo. Mejor esperar a fin de semana antes de insistir.' },
{ clienteId: 'c03', score: 24, nivel: 'baja', razon: 'Monto bajo y promesa de pago para hoy. Sin acción hasta mañana.' },
{ clienteId: 'c06', score: 15, nivel: 'baja', razon: 'Su factura vence en 3 días. Basta un recordatorio preventivo.' },
{ clienteId: 'c10', score: 6, nivel: 'baja', razon: 'Al día. Su factura vence en 12 días.' }];


export const mensajes: Mensaje[] = [
{ id: 'm01', clienteId: 'c01', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(12, 2), contenido: 'Hola Jorge, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1042 por $28,500.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm02', clienteId: 'c01', rol: 'agente', agente: 'redactor', tono: 'firme', esPlantilla: true, fecha: hace(4, 1), contenido: 'Jorge, seguimos sin registrar el pago de las facturas F-1042 y F-1088 por un total de $48,750.00 MXN. Necesitamos acordar una fecha esta semana para evitar recargos. Responde este mensaje y lo resolvemos.' },
{ id: 'm03', clienteId: 'c01', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(0, 6), contenido: 'Hola, sí ya sé. Este mes estuvo muy flojo, ¿podemos ver una opción en pagos?' },
{ id: 'm04', clienteId: 'c01', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(0, 5, 50), contenido: 'Claro, Jorge. Podemos dividirlo en dos pagos de $24,375.00 MXN: el primero este viernes y el segundo 15 días después. ¿Te funciona?' },

{ id: 'm05', clienteId: 'c02', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(40, 3), contenido: 'Hola Ramón, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-0981 por $85,000.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm06', clienteId: 'c02', rol: 'agente', agente: 'redactor', tono: 'firme', esPlantilla: true, fecha: hace(25, 2), contenido: 'Ramón, seguimos sin registrar el pago de la factura F-0981 por $85,000.00 MXN, con 87 días de atraso. Necesitamos acordar una fecha de pago esta semana para evitar recargos.' },
{ id: 'm07', clienteId: 'c02', rol: 'agente', agente: 'redactor', tono: 'final', esPlantilla: true, fecha: hace(6, 4), contenido: 'Ramón, este es nuestro último aviso sobre la factura F-0981 por $85,000.00 MXN. Si no recibimos respuesta en 48 horas, el adeudo se turnará a nuestro despacho jurídico. Aún podemos acordar un plan de pagos si nos escribes hoy.' },

{ id: 'm08', clienteId: 'c03', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(3, 2), contenido: 'Hola María, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1120 por $6,480.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm09', clienteId: 'c03', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(0, 7), contenido: 'Hola, perdón por la demora. Hoy en la tarde les deposito los $6,480.' },
{ id: 'm10', clienteId: 'c03', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(0, 6, 55), contenido: '¡Muchas gracias, María! Registré tu compromiso de pago para hoy por $6,480.00 MXN. Te confirmamos en cuanto lo recibamos.' },

{ id: 'm11', clienteId: 'c05', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(30, 1), contenido: 'Hola Luis Fernando, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1003 por $31,200.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla?' },
{ id: 'm12', clienteId: 'c05', rol: 'agente', agente: 'redactor', tono: 'firme', esPlantilla: true, fecha: hace(14, 3), contenido: 'Luis Fernando, seguimos sin registrar el pago de la factura F-1003 por $31,200.00 MXN, con 81 días de atraso. Necesitamos acordar una fecha de pago esta semana.' },
{ id: 'm13', clienteId: 'c05', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(2, 4), contenido: 'Ese cargo de $31,200 no lo reconozco completo, la refacción llegó defectuosa y ya la regresamos. No pienso pagar eso así.' },
{ id: 'm14', clienteId: 'c05', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(2, 3, 55), contenido: 'Gracias por avisarnos, Luis Fernando. Para revisarlo con cuidado, voy a pasar tu caso a una persona de nuestro equipo. Te contactarán hoy mismo y mientras tanto pausamos los recordatorios.' },

{ id: 'm15', clienteId: 'c09', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(9, 5), contenido: 'Hola Ricardo, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1061 por $54,300.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },

{ id: 'm16', clienteId: 'c12', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(5, 2), contenido: 'Hola Verónica, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1030 por $26,750.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm17', clienteId: 'c12', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(0, 2, 10), contenido: 'Buenas, ¿me pueden reenviar la factura? No la encuentro en el correo.' },
{ id: 'm18', clienteId: 'c12', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(0, 2, 5), contenido: 'Claro, Verónica. Te la reenvié a compras@farmaciasanrafael.mx. ¿Podrías confirmarnos la fecha de pago una vez que la revises?' },

{ id: 'm19', clienteId: 'c15', rol: 'agente', agente: 'redactor', tono: 'firme', esPlantilla: true, fecha: hace(6, 3), contenido: 'Fernando, seguimos sin registrar el pago de la factura F-1080 por $39,800.00 MXN, con 35 días de atraso. Necesitamos acordar una fecha de pago esta semana para evitar recargos.' },
{ id: 'm20', clienteId: 'c15', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(3, 1), contenido: 'Les pago completo el jueves, ya tengo el dinero comprometido.' },
{ id: 'm21', clienteId: 'c15', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(3, 0, 55), contenido: 'Perfecto, Fernando. Queda registrada tu promesa de pago por $39,800.00 MXN para el jueves. ¡Gracias!' },

{ id: 'm22', clienteId: 'c08', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(5, 2), contenido: 'Hola Sofía, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1138 por $9,860.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm23', clienteId: 'c08', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(4, 6), contenido: 'Sí, les pago el lunes sin falta.' },
{ id: 'm24', clienteId: 'c08', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(4, 5, 55), contenido: 'Gracias, Sofía. Registré tu compromiso de pago por $9,860.00 MXN para el lunes.' },

{ id: 'm25', clienteId: 'c13', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(1, 3), contenido: 'Hola Eduardo, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1072 por $15,600.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },

{ id: 'm26', clienteId: 'c07', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(50, 2), contenido: 'Hola Héctor, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-0955 por $47,400.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla?' },
{ id: 'm27', clienteId: 'c07', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(32, 5), contenido: 'Ahorita no tengo, en cuanto me paguen una obra les pago todo.' },
{ id: 'm28', clienteId: 'c07', rol: 'agente', agente: 'negociador', tono: 'firme', esPlantilla: false, fecha: hace(32, 4), contenido: 'Entiendo, Héctor. Para no seguir acumulando atraso, ¿podemos acordar al menos un primer abono de $15,000.00 MXN este mes?' },
{ id: 'm29', clienteId: 'c07', rol: 'agente', agente: 'redactor', tono: 'firme', esPlantilla: true, fecha: hace(10, 2), contenido: 'Héctor, seguimos sin registrar el pago de las facturas F-0955 y F-0990 por $72,400.00 MXN. Necesitamos acordar una fecha de pago esta semana para evitar recargos.' },

{ id: 'm30', clienteId: 'c11', rol: 'agente', agente: 'redactor', tono: 'amable', esPlantilla: true, fecha: hace(5, 4), contenido: 'Hola Arturo, buen día. Te escribimos de Distribuidora del Valle para recordarte que la factura F-1109 por $18,900.00 MXN está pendiente de pago. ¿Nos ayudas confirmando la fecha en que podrás cubrirla? ¡Gracias!' },
{ id: 'm31', clienteId: 'c11', rol: 'cliente', agente: null, tono: null, esPlantilla: false, fecha: hace(2, 2), contenido: 'Buenas, les pago el próximo viernes cuando cierre la quincena.' },
{ id: 'm32', clienteId: 'c11', rol: 'agente', agente: 'negociador', tono: 'amable', esPlantilla: false, fecha: hace(2, 1, 50), contenido: 'Perfecto, Arturo. Queda registrado tu compromiso por $18,900.00 MXN. ¡Gracias por avisar!' }];


export const eventosAgente: EventoAgente[] = [
{ id: 'e01', clienteId: null, agente: 'analista', accion: 'Recalculó prioridades', detalle: '15 clientes evaluados · 5 en prioridad alta', estado: 'completado', fecha: hace(0, 0, 3) },
{ id: 'e02', clienteId: 'c13', agente: 'redactor', accion: 'Preparó seguimiento', detalle: 'Tono amable para Imprenta Morales', estado: 'completado', fecha: hace(0, 0, 9) },
{ id: 'e03', clienteId: 'c12', agente: 'negociador', accion: 'Respondió al cliente', detalle: 'Reenvió la factura F-1030 a Farmacia San Rafael', estado: 'completado', fecha: hace(0, 0, 18) },
{ id: 'e04', clienteId: null, agente: 'director', accion: 'Resumen matutino listo', detalle: '$354,400 vencidos · 4 promesas activas', estado: 'completado', fecha: hace(0, 0, 34) },
{ id: 'e05', clienteId: 'c03', agente: 'negociador', accion: 'Registró promesa de pago', detalle: '$6,480.00 MXN · Abarrotes Doña Mary · hoy', estado: 'completado', fecha: hace(0, 0, 52) },
{ id: 'e06', clienteId: 'c09', agente: 'analista', accion: 'Subió prioridad', detalle: 'Transportes Gómez pasó de media a alta', estado: 'completado', fecha: hace(0, 1, 15) },
{ id: 'e07', clienteId: 'c05', agente: 'negociador', accion: 'Escaló a humano', detalle: 'Refaccionaria Castillo disputa el cargo', estado: 'error', fecha: hace(0, 2, 5) },
{ id: 'e08', clienteId: 'c01', agente: 'negociador', accion: 'Propuso plan de pagos', detalle: 'Dos pagos de $24,375.00 MXN · Ferretería López', estado: 'completado', fecha: hace(0, 3, 40) }];


export const promesas: PromesaPago[] = [
{ id: 'p01', clienteId: 'c03', facturaId: 'f04', monto: 6480, fechaCompromiso: hace(0), estado: 'pendiente' },
{ id: 'p02', clienteId: 'c15', facturaId: 'f18', monto: 39800, fechaCompromiso: en(3), estado: 'pendiente' },
{ id: 'p03', clienteId: 'c11', facturaId: 'f14', monto: 18900, fechaCompromiso: en(4), estado: 'pendiente' },
{ id: 'p04', clienteId: 'c08', facturaId: 'f11', monto: 9860, fechaCompromiso: hace(1), estado: 'pendiente' },
{ id: 'p05', clienteId: 'c04', facturaId: 'f06', monto: 8200, fechaCompromiso: hace(12), estado: 'cumplida' }];


export const escalamientos: Escalamiento[] = [
{ id: 's01', clienteId: 'c05', motivo: 'Disputa el cargo: la refacción llegó defectuosa y ya fue devuelta.', fecha: hace(2, 3, 55), resuelto: false }];


export const recuperacionSemanal: PuntoSerie[] = [
{ etiqueta: '18 ago', valor: 18400 },
{ etiqueta: '25 ago', valor: 22150 },
{ etiqueta: '1 sep', valor: 15900 },
{ etiqueta: '8 sep', valor: 27300 },
{ etiqueta: '15 sep', valor: 24800 },
{ etiqueta: '22 sep', valor: 31600 },
{ etiqueta: '29 sep', valor: 29450 },
{ etiqueta: '6 oct', valor: 38200 }];
/** Momento en que se generaron las fechas relativas de este módulo. */
export const generadoEn = Date.now();
