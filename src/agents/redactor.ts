/**
 * Redactor: escribe el mensaje de cobranza con el tono adecuado.
 *
 * Regla de WhatsApp: fuera de la ventana de 24 h solo se pueden enviar
 * PLANTILLAS aprobadas por Meta. Por eso:
 *   · ventana cerrada → plantilla aprobada (amable / firme / final) con variables.
 *   · ventana abierta → la IA redacta un mensaje libre y personalizado.
 */
import { generateText } from 'ai';
import type { Db } from '../domain/db.js';
import { facturasAbiertas, porFecha } from '../domain/logic.js';
import { formatMXN, primerNombre } from '../shared/format.js';
import { plantillas } from '../shared/plantillas.js';
import { estadoVentana, llenarPlantilla } from '../shared/reglas.js';
import type { ClienteResumen, Tono } from '../shared/types.js';
import { iaDisponible, modelo, registrarErrorIA, conLimite, opcionesRapidas } from './modelo.js';

export interface Borrador {
  contenido: string;
  esPlantilla: boolean;
  tono: Tono;
  /** Variables en orden, para los parámetros {{1}}, {{2}}… de la plantilla de Meta. */
  variables: Record<string, string>;
}

export function variablesDe(db: Db, c: ClienteResumen): Record<string, string> {
  return {
    nombre: primerNombre(c.nombre),
    empresa: db.perfil.empresa,
    folio: facturasAbiertas(db, c.id).map((f) => f.folio).join(' y '),
    monto: formatMXN(c.deuda),
    dias: String(c.diasAtraso)
  };
}

const GUIA_TONO: Record<Tono, string> = {
  amable: 'cordial, asume que fue un olvido',
  firme: 'directo y respetuoso, menciona el atraso y pide una fecha esta semana',
  final: 'último aviso, serio pero sin amenazas; ofrece un plan de pagos si responde hoy'
};

export async function redactar(db: Db, c: ClienteResumen, tono: Tono): Promise<Borrador> {
  const variables = variablesDe(db, c);
  const mensajes = db.mensajes.filter((m) => m.clienteId === c.id).sort(porFecha);
  const ventana = estadoVentana(mensajes);
  const plantilla = plantillas.find((p) => p.tono === tono) ?? plantillas[0];
  const dePlantilla: Borrador = { contenido: llenarPlantilla(plantilla.contenido, variables), esPlantilla: true, tono, variables };

  if (!ventana.abierta || !iaDisponible) return ventana.abierta ? { ...dePlantilla, esPlantilla: false } : dePlantilla;

  try {
    const historial = mensajes
      .slice(-6)
      .map((m) => `${m.rol === 'cliente' ? 'Cliente' : 'Nosotros'}: ${m.contenido}`)
      .join('\n');
    const { text } = await generateText({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(15_000),
      temperature: 0.6,
      system:
        `Eres el Redactor de cobranza de ${db.perfil.empresa}, una PyME mexicana. Escribe UN mensaje de WhatsApp en español de México, ` +
        `máximo 3 frases, tono ${tono} (${GUIA_TONO[tono]}). Usa el primer nombre del cliente, menciona folio y monto exactos. ` +
        'Sin emojis, sin amenazas, sin inventar recargos ni datos. Devuelve solo el texto del mensaje.',
      prompt: `Cliente: ${c.nombre} (${c.empresa}). Facturas: ${variables.folio}. Saldo: ${variables.monto}. Atraso: ${c.diasAtraso} días.\n\nConversación reciente:\n${historial}`
    });
    const contenido = text.trim();
    return contenido ? { contenido, esPlantilla: false, tono, variables } : { ...dePlantilla, esPlantilla: false };
  } catch (error) {
    registrarErrorIA('Redactor', error);
    return { ...dePlantilla, esPlantilla: false };
  }
}
