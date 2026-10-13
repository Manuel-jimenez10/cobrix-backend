/**
 * Negociador: contesta al deudor dentro de la ventana de 24 h.
 * Usa tool calling para registrar promesas de pago o escalar a un humano;
 * la respuesta llega en streaming al chat (y por WhatsApp si el canal está activo).
 */
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../domain/db.js';
import { facturasAbiertas, porFecha } from '../domain/logic.js';
import { formatFecha, formatMXN, primerNombre } from '../shared/format.js';
import { describirParaAgente, validarPromesa } from '../shared/politicas.js';
import type { ClienteResumen, Tono } from '../shared/types.js';
import { hoyTexto, iaDisponible, modelo, registrarErrorIA, turnosAlternados, conLimite, opcionesRapidas } from './modelo.js';
import { responderNegociador } from './respaldo.js';

export interface ResultadoNegociacion {
  texto: string;
  tono: Tono;
  promesa?: { monto: number; dias: number };
  escalamiento?: { motivo: string };
  conIA: boolean;
}

async function* trozos(texto: string): AsyncGenerator<string> {
  for (const parte of texto.match(/\S+\s*/g) ?? []) {
    await new Promise((r) => setTimeout(r, 18));
    yield parte;
  }
}

export async function negociar(
  db: Db,
  cliente: ClienteResumen,
  onDelta: (texto: string) => void
): Promise<ResultadoNegociacion> {
  const respaldo = async (): Promise<ResultadoNegociacion> => {
    // El mensaje del cliente ya está en db.mensajes; las reglas leen el último.
    const ultimo = db.mensajes.filter((m) => m.clienteId === cliente.id && m.rol === 'cliente').sort(porFecha).at(-1);
    const r = responderNegociador(db, cliente.id, ultimo?.contenido ?? '', db.perfil.politicas);
    for await (const d of trozos(r.texto)) onDelta(d);
    return {
      texto: r.texto,
      tono: r.tono,
      promesa: r.resultado === 'promesa' ? { monto: r.montoCompromiso ?? cliente.deuda, dias: r.diasCompromiso ?? 0 } : undefined,
      escalamiento: r.resultado === 'escalar' ? { motivo: r.motivo ?? 'Requiere revisión humana.' } : undefined,
      conIA: false
    };
  };

  if (!iaDisponible) return respaldo();

  const facturas = facturasAbiertas(db, cliente.id);
  const historial = turnosAlternados(
    db.mensajes
      .filter((m) => m.clienteId === cliente.id)
      .sort(porFecha)
      .slice(-14)
      .map((m) => ({ role: m.rol === 'cliente' ? ('user' as const) : ('assistant' as const), content: m.contenido }))
  );

  const politicas = db.perfil.politicas;
  let promesa: ResultadoNegociacion['promesa'];
  let escalamiento: ResultadoNegociacion['escalamiento'];

  const tools = {
    registrar_promesa: tool({
      description:
        'Registra una promesa de pago SOLO cuando el cliente se compromete explícitamente a una fecha (y opcionalmente un monto). ' +
        'Si paga en partes, registra únicamente el primer pago. El sistema valida la política de la empresa: ' +
        'si responde registrada=false, NO confirmes nada al cliente y propón una alternativa que cumpla el motivo indicado.',
      inputSchema: z.object({
        monto: z.number().positive().describe('Monto en MXN del pago comprometido (el primero, si es en partes)'),
        dias: z.number().int().min(0).max(365).describe('Días a partir de hoy hasta la fecha de pago (0 = hoy)'),
        pagos: z.number().int().min(1).max(12).describe('En cuántos pagos se cubrirá el saldo (1 = un solo pago)'),
        liquidaTotal: z.boolean().describe('true si con este pago el cliente liquida todo el saldo (con o sin descuento)')
      }),
      execute: async ({ monto, dias, pagos, liquidaTotal }) => {
        const montoFinal = Math.min(Math.round(monto * 100) / 100, cliente.deuda);
        const validacion = validarPromesa(politicas, cliente.deuda, { monto: montoFinal, dias, pagos, liquidaTotal });
        if (!validacion.ok) return { registrada: false, motivo: validacion.motivo };
        promesa = { monto: montoFinal, dias };
        return { registrada: true, monto: formatMXN(montoFinal), fecha: formatFecha(new Date(Date.now() + dias * 86_400_000).toISOString()) };
      }
    }),
    escalar_a_humano: tool({
      description:
        'Pasa el caso a una persona del equipo y pausa los recordatorios, según las políticas de escalamiento de la empresa. ' +
        'Si responde escalado=false, la política indica que lo atiendas tú: sigue negociando con empatía.',
      inputSchema: z.object({
        categoria: z
          .enum(['disputa', 'productoDefectuoso', 'legal', 'pideHumano', 'otro'])
          .describe('disputa = no reconoce el cargo; productoDefectuoso; legal = abogados/PROFECO/demanda; pideHumano; otro = se niega rotundamente a pagar u otra situación grave'),
        motivo: z.string().describe('Motivo breve para el equipo')
      }),
      execute: async ({ categoria, motivo }) => {
        if (categoria !== 'otro' && !politicas.escalar[categoria]) {
          return { escalado: false, motivo: 'La política de la empresa indica que este caso lo atiendas tú.' };
        }
        escalamiento = { motivo };
        return { escalado: true };
      }
    })
  };

  let texto = '';
  try {
    const resultado = streamText({
      model: modelo(),
      providerOptions: opcionesRapidas,
      abortSignal: conLimite(30_000),
      temperature: 0.4,
      stopWhen: stepCountIs(3),
      tools,
      system: [
        `Eres el Negociador de cobranza de ${db.perfil.empresa}, una PyME mexicana. Hablas por WhatsApp con ${cliente.nombre} (${cliente.empresa}).`,
        `Hoy es ${hoyTexto()}. Saldo pendiente: ${formatMXN(cliente.deuda)} en ${facturas.length} factura(s): ` +
          facturas.map((f) => `${f.folio} por ${formatMXN(f.monto)} (${f.diasAtraso} días de atraso)`).join('; ') + '.',
        'Objetivo: conseguir un compromiso de pago concreto (fecha y monto) manteniendo una buena relación.',
        `Políticas de ${db.perfil.empresa} (obligatorias):\n${describirParaAgente(politicas)}`,
        'No amenaces, no inventes recargos ni datos.',
        'Cuando el cliente se comprometa a una fecha, llama a registrar_promesa ANTES de responder y confirma la fecha en formato dd/mm/aaaa.',
        'Si aplica escalar_a_humano, llámala y avisa con empatía que una persona lo contactará hoy.',
        `Responde en español de México, breve (máximo 3 frases), cálido y profesional, llamándolo por su primer nombre (${primerNombre(cliente.nombre)}). Sin emojis.`
      ].join('\n'),
      messages: historial
    });

    for await (const parte of resultado.fullStream) {
      if (parte.type === 'text-delta') {
        texto += parte.text;
        onDelta(parte.text);
      } else if (parte.type === 'error') {
        throw parte.error;
      }
    }
  } catch (error) {
    registrarErrorIA('Negociador', error);
    if (!texto) return respaldo();
  }

  texto = texto.trim();
  if (!texto) {
    texto = promesa
      ? `Perfecto, ${primerNombre(cliente.nombre)}. Registré tu compromiso por ${formatMXN(promesa.monto)} para el ${formatFecha(new Date(Date.now() + promesa.dias * 86_400_000).toISOString())}. ¡Gracias!`
      : `Gracias por tu mensaje, ${primerNombre(cliente.nombre)}. ¿Qué fecha te funciona para cubrir el saldo de ${formatMXN(cliente.deuda)}?`;
    for await (const d of trozos(texto)) onDelta(d);
  }
  return { texto, tono: cliente.diasAtraso > 60 && !promesa ? 'firme' : 'amable', promesa, escalamiento, conIA: true };
}
